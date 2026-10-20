"""Real detached-process regression for the validation launcher; no Sage job is started."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

runner = Path(__file__).with_name('validation-run.py')
assert runner.is_file(), 'Missing durable validation launcher'
with tempfile.TemporaryDirectory(prefix='validation-proof-') as temporary:
    root = Path(temporary)
    source = root / 'source'
    source.mkdir()
    (source / 'value').write_text('original')
    program = source / 'check.py'
    program.write_text("import pathlib,time\ntime.sleep(1)\nprint(pathlib.Path('value').read_text(), flush=True)\nraise SystemExit(7)\n")
    spec = root / 'spec.json'
    spec.write_text(json.dumps(dict(sources={'project': str(source)}, cwd='{project}',
        argv=[sys.executable, 'check.py'], env={}, transport=[], mode='command')))
    jobs = root / 'jobs'
    launch = subprocess.run([sys.executable, str(runner), 'start', str(spec), str(jobs)], text=True, capture_output=True, check=True)
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
    print('Detached result survived caller exit; duplicate refused; source edit isolated; exit 7 preserved.')

# The caller supplies a real pytest interpreter; Sage uses the same plugin hooks.
if len(sys.argv) > 1:
    with tempfile.TemporaryDirectory(prefix='validation-pytest-proof-') as temporary:
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
            argv=[sys.argv[1]], env={}, transport=[], mode='pytest',
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
        assert json.loads((retry / 'pytest.json').read_text())['selected'] == failed['failedNodes']
        (source / 'value').write_text('another unfinished edit')
        full, completed = run_job('--full-after', str(retry))
        assert completed['exitCode'] == 0, completed
        assert json.loads((full / 'manifest.json').read_text())['inputs'] == json.loads((retry / 'manifest.json').read_text())['inputs']
        assert json.loads((full / 'pytest.json').read_text())['selected'] == [
            'test_consumer.py::test_consumer[case16]', 'test_consumer.py::test_consumer[case160]']
        print('Real pytest: exact failed node only, then complete inventory on the identical repaired snapshot.')

        (retry / 'inputs/project/value').write_text('tampered snapshot')
        stale = subprocess.run([sys.executable, str(runner), 'start', str(spec), str(root / 'jobs'),
                                '--full-after', str(retry)], capture_output=True)
        assert stale.returncode != 0, 'A modified accepted snapshot was silently reused'
