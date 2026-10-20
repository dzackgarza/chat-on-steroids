"""Real detached-process regression for the validation launcher; no Sage job is started."""
import hashlib
import json
import os
import shutil
import shlex
from pathlib import Path
import subprocess
import sys
import tempfile
import time

runner = Path(__file__).with_name('validation-run.py')
assert runner.is_file(), 'Missing durable validation launcher'
docker = shutil.which('docker')
assert docker, 'Docker is required for isolated validation'
image = subprocess.check_output(['/usr/bin/sg', 'docker', '-c',
    shlex.join([docker, 'image', 'inspect', 'cos-validation-development:local', '--format', '{{.Id}}'])], text=True).strip()
runtime = dict(image=image, developmentImage=image, docker=docker, group='docker')
cache = Path.home() / '.cache'
cache.mkdir(exist_ok=True)

with tempfile.TemporaryDirectory(prefix='validation-proof-', dir=cache) as temporary:
    root = Path(temporary)
    source = root / 'source'
    source.mkdir()
    (source / 'value').write_text('original')
    program = source / 'check.py'
    outside = root / 'host-only'
    outside.write_text('protected')
    program.write_text(f"""import pathlib,time,os
assert 'COS_HOST_ONLY_PROBE' not in os.environ
assert not pathlib.Path({str(outside)!r}).exists()
for target in (pathlib.Path('value'), pathlib.Path(__file__).parents[2] / 'manifest.json'):
    try:
        target.write_text('forbidden')
    except OSError:
        pass
    else:
        raise AssertionError('controller input writable')
""" + "import pathlib,time\ntime.sleep(1)\nprint(pathlib.Path('value').read_text(), flush=True)\nraise SystemExit(7)\n")
    spec = root / 'spec.json'
    spec.write_text(json.dumps(dict(sources={'project': str(source)}, cwd='{project}',
        argv=['/usr/bin/python3', 'check.py'], env={}, runtime=runtime, mode='command')))
    native = root / 'native.json'
    native.write_text(json.dumps(dict(sources={'project': str(source)}, cwd='{project}',
        argv=[sys.executable, 'check.py'], env={}, transport=[], mode='command')))
    refused = subprocess.run([sys.executable, str(runner), 'start', str(native), str(root / 'native-jobs')], capture_output=True)
    assert refused.returncode != 0, 'Native validation remains available'
    jobs = root / 'jobs'
    launch = subprocess.run([sys.executable, str(runner), 'start', str(spec), str(jobs)], text=True, capture_output=True, check=True,
                            env={**os.environ, 'COS_HOST_ONLY_PROBE': 'must-not-cross'})
    run = Path(json.loads(launch.stdout)['directory'])
    assert not (run / 'result.json').exists(), 'launch waited for the computation'
    duplicate = subprocess.run([sys.executable, str(runner), 'start', str(spec), str(jobs)], capture_output=True)
    assert duplicate.returncode != 0, 'duplicate launched while the first run was active'
    (source / 'value').write_text('edited while running')
    deadline = time.monotonic() + 15
    while not (run / 'result.json').exists() and time.monotonic() < deadline:
        time.sleep(.05)
    result = json.loads((run / 'result.json').read_text())
    assert result['exitCode'] == 7, result
    assert result['runId'] == run.name
    assert result['manifestHash'] == hashlib.sha256((run / 'manifest.json').read_bytes()).hexdigest()
    assert (run / 'output.log').read_text() == 'original\n'
    assert result['inputsUnchanged'] is True
    assert (run / 'process.json').is_file()
    print('Container denied host access, inherited host environment and snapshot/manifest writes; detached exit 7 preserved.')

# The validation image supplies pytest; Sage uses the same plugin hooks.
if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='validation-pytest-proof-', dir=cache) as temporary:
        root = Path(temporary)
        source = root / 'source'
        source.mkdir()
        (source / 'value').write_text('broken')
        (source / 'test_consumer.py').write_text('''import pathlib
import pytest
@pytest.mark.parametrize("case", [16,160], ids=["case16", "case160"])
def test_consumer(case):
    assert case == 160 or pathlib.Path("value").read_text() == "repaired"
''')
        spec = root / 'spec.json'
        spec.write_text(json.dumps(dict(sources={'project': str(source)}, cwd='{project}',
            argv=['/usr/bin/python3'], env={}, runtime=runtime, mode='pytest',
            files=['test_consumer.py'], imports=[], plugins=[])))
        def run_job(*extra):
            process = subprocess.run([sys.executable, str(runner), 'start', str(spec), str(root / 'jobs'), *extra],
                                     text=True, capture_output=True, check=True)
            directory = Path(json.loads(process.stdout)['directory'])
            deadline = time.monotonic() + 20
            while not (directory / 'result.json').exists() and time.monotonic() < deadline:
                time.sleep(.05)
            return directory, json.loads((directory / 'result.json').read_text())
        first, failed = run_job()
        assert failed['exitCode'] == 1, (failed, (first / 'output.log').read_text())
        assert failed['failedNodes'] == ['test_consumer.py::test_consumer[case16]']
        (source / 'value').write_text('repaired')
        retry, passed = run_job('--retry', str(first))
        assert passed['exitCode'] == 0, (passed, (retry / 'output.log').read_text())
        assert json.loads((retry / 'reports' / 'pytest.json').read_text())['selected'] == failed['failedNodes']
        (source / 'value').write_text('another unfinished edit')
        full, completed = run_job('--full-after', str(retry))
        assert completed['exitCode'] == 0, completed
        assert json.loads((full / 'manifest.json').read_text())['inputs'] == json.loads((retry / 'manifest.json').read_text())['inputs']
        assert json.loads((full / 'reports' / 'pytest.json').read_text())['selected'] == [
            'test_consumer.py::test_consumer[case16]', 'test_consumer.py::test_consumer[case160]']
        print('Real pytest: exact failed node only, then complete inventory on the identical repaired snapshot.')

        (retry / 'inputs/project/value').write_text('tampered snapshot')
        stale = subprocess.run([sys.executable, str(runner), 'start', str(spec), str(root / 'jobs'),
                                '--full-after', str(retry)], capture_output=True)
        assert stale.returncode != 0, 'A modified accepted snapshot was silently reused'

        host_report = root / 'host-report.json'
        host_report.write_text(json.dumps(dict(failedNodes=['private-host-node'], selected=[])))
        (source / 'test_consumer.py').write_text(f"""import os
from pathlib import Path
(Path(__file__).parents[2] / 'reports' / 'pytest.json').symlink_to({str(host_report)!r})
os._exit(0)
""")
        linked, rejected = run_job()
        assert rejected['error'] and rejected['failedNodes'] == [], rejected
        assert 'private-host-node' not in (linked / 'result.json').read_text()
        print('Candidate report links cannot redirect the supervisor into host files.')
