#!/usr/bin/env python3
"""Detached validation over copied inputs.

start SPEC JOBS [--retry RUN | --full-after RUN]
SPEC supplies sources, cwd, argv, env, mode and a mandatory container runtime.
Paths in cwd/argv/env use {source-name}. The host supervisor owns snapshots and
terminal receipts. Candidate code runs only inside a fresh container with
read-only inputs and a writable report directory. Retry selects exact failed
pytest node IDs; full-after retains the passing retry snapshot.
No computation timeout is inferred from tool deadlines.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import shlex
import subprocess
import sys
import time
import uuid


def write_json(path, value):
    temporary = path.with_suffix('.new')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


IGNORED = {'.git', '.venv', 'node_modules', '__pycache__', '.pytest_cache', '.tmp', '.ai-review-ci'}


def source_files(root):
    for directory, folders, files in os.walk(root, followlinks=False):
        folders[:] = sorted(name for name in folders if name not in IGNORED)
        for name in folders:
            if (Path(directory) / name).is_symlink():
                raise ValueError(f'Snapshot input contains a directory symlink: {Path(directory) / name}')
        for name in sorted(files):
            if not name.endswith('.pyc'):
                yield Path(directory) / name


def inventory(root):
    result = {}
    for item in source_files(root):
        if item.is_symlink():
            raise ValueError(f'Snapshot input contains a symlink: {item}; supply its resolved source explicitly')
        if item.is_file() and '__pycache__' not in item.parts and item.suffix != '.pyc':
            result[str(item.relative_to(root))] = digest(item)
    return result


def copy_source(source, destination):
    # Explicit source directories, not a repository-wide cache/worktree copy.
    shutil.copytree(source, destination, ignore=shutil.ignore_patterns(*IGNORED, '*.pyc'))


def validate_runtime(spec):
    if 'transport' in spec:
        raise ValueError('Validation transport overrides are not supported')
    runtime = spec['runtime']
    if set(runtime) != {'image', 'developmentImage', 'docker', 'group'}:
        raise ValueError('A complete container runtime is required')
    for key in ('image', 'developmentImage'):
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', runtime[key]):
            raise ValueError('Runtime images must be immutable image IDs')
    if not Path(runtime['docker']).is_absolute() or not re.fullmatch(r'[a-z_][a-z0-9_-]*', runtime['group']):
        raise ValueError('Invalid container runtime')


def container_command(runtime, image, argv, cwd, mounts, environment):
    command = [runtime['docker'], 'run', '--rm', '--network', 'none', '--read-only',
               '--cap-drop', 'ALL', '--pids-limit', '256', '--user', f'{os.getuid()}:{os.getgid()}',
               '--tmpfs', '/tmp:rw,nosuid,nodev', '--workdir', cwd,
               '--env', 'HOME=/tmp', '--env', 'PATH=/usr/bin:/bin']
    for source, readonly in mounts:
        if ',' in source or not Path(source).is_absolute():
            raise ValueError('Container mounts require absolute paths without commas')
        command += ['--mount', f'type=bind,src={source},dst={source}' + (',readonly' if readonly else '')]
    for key, value in environment.items():
        command += ['--env', f'{key}={value}']
    command += ['--entrypoint', argv[0], image, *argv[1:]]
    return ['/usr/bin/sg', runtime['group'], '-c', shlex.join(command)]


def start(spec_path, jobs, retry, full_after, request_id):
    jobs.mkdir(parents=True, exist_ok=True)
    with (jobs / 'launch.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        active = jobs / 'active.json'
        if active.exists():
            prior = Path(json.loads(active.read_text())['directory'])
            manifest = json.loads((prior / 'manifest.json').read_text())
            if request_id and manifest.get('requestId') == request_id:
                print(json.dumps({'directory': str(prior), 'runId': prior.name}))
                return
            if not (prior / 'result.json').exists():
                raise RuntimeError(f'Existing validation has no terminal result: {prior}; inspect it, do not duplicate it')
        spec = json.loads(spec_path.read_text())
        validate_runtime(spec)
        if spec['mode'] not in ('command', 'pytest'):
            raise ValueError('mode must be command or pytest')
        run = jobs / str(uuid.uuid4())
        run.mkdir()
        selected = []
        previous_manifest = None
        if retry or full_after:
            prior = retry or full_after
            result = json.loads((prior / 'result.json').read_text())
            previous_manifest = json.loads((prior / 'manifest.json').read_text())
            if result['manifestHash'] != digest(prior / 'manifest.json') or not result['inputsUnchanged']:
                raise ValueError('Previous evidence has changed inputs')
            if inventory(prior / 'inputs') != previous_manifest['inputs']:
                raise ValueError('Previous snapshot changed after validation')
            if previous_manifest['spec'] != spec:
                raise ValueError('Retry/full-after must retain the original execution specification')
            if spec['mode'] != 'pytest':
                raise ValueError('Exact consumer retry requires pytest reports')
            if retry:
                selected = result['failedNodes']
                if not selected:
                    raise ValueError('No recorded failed consumer; diagnose collection/crash before retrying')
            elif result['exitCode'] != 0 or not previous_manifest['selected']:
                raise ValueError('Full-after requires a successful exact consumer retry')
        snapshots = run / 'inputs'
        snapshots.mkdir()
        for name, source in spec['sources'].items():
            if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*', name):
                raise ValueError(f'Invalid source name: {name}')
            origin = (full_after / 'inputs' / name) if full_after else Path(source).resolve()
            before = inventory(origin)
            copy_source(origin, snapshots / name)
            copied = inventory(snapshots / name)
            # Match copied paths; excluded caches never become test inputs.
            if any(before.get(key) != value for key, value in copied.items()) or inventory(origin) != before:
                raise RuntimeError(f'Source changed during snapshot: {origin}; no validation launched')
        revisions = {}
        for name, source in spec['sources'].items():
            command = container_command(spec['runtime'], spec['runtime']['developmentImage'],
                                        ['git', '-C', source, 'rev-parse', 'HEAD'], source,
                                        [(source, True)], {})
            revision = subprocess.run(command, capture_output=True, text=True)
            revisions[name] = revision.stdout.strip() if revision.returncode == 0 else None
        if full_after:
            revisions = previous_manifest['revisions']
        manifest = dict(version=1, runId=run.name, requestId=request_id, spec=spec, selected=selected,
                        inputs=inventory(snapshots), revisions=revisions, createdAt=time.time(),
                        previous=str(retry or full_after) if retry or full_after else None)
        write_json(run / 'manifest.json', manifest)
        shutil.copyfile(__file__, run / 'runner.py')
        write_json(active, {'directory': str(run)})
        command = [str(run / 'runner.py'), '_execute', str(run)]
        (run / 'reports').mkdir()
        with (run / 'supervisor.log').open('ab') as output:
            subprocess.Popen([sys.executable, *command], stdin=subprocess.DEVNULL,
                             stdout=output, stderr=output, start_new_session=True)
        print(json.dumps({'directory': str(run), 'runId': run.name,
                          'result': str(run / 'result.json'), 'log': str(run / 'output.log')}))


def execute(run):
    manifest = json.loads((run / 'manifest.json').read_text())
    spec = manifest['spec']
    mapping = {name: str(run / 'inputs' / name) for name in spec['sources']}
    expand = lambda value: value.format_map(mapping)
    environment = {key: expand(value) for key, value in spec['env'].items()}
    environment['PYTHONDONTWRITEBYTECODE'] = '1'
    command = [expand(arg) for arg in spec['argv']]
    if spec['mode'] == 'pytest':
        command += [str(run / 'runner.py'), '_pytest', str(run)]
    command = container_command(spec['runtime'], spec['runtime']['image'], command,
                                expand(spec['cwd']), [(str(run), True), (str(run / 'reports'), False)],
                                environment)
    code, signal, error = None, None, None
    failed_nodes = []
    try:
        with (run / 'output.log').open('ab', buffering=0) as output:
            child = subprocess.Popen(command,
                                     stdin=subprocess.DEVNULL, stdout=output, stderr=output)
            write_json(run / 'process.json', dict(runId=run.name, supervisor=os.getpid(),
                       child=child.pid, command=command, startedAt=time.time()))
            status = child.wait()
            code = status if status >= 0 else None
            signal = -status if status < 0 else None
        if spec['mode'] == 'pytest':
            # Reports are candidate output. Never follow their links into host files.
            descriptor = os.open(run / 'reports' / 'pytest.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor) as report_file:
                metadata = os.fstat(report_file.fileno())
                if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 16 * 1024 * 1024:
                    raise ValueError('Validation report must be a regular file under 16 MiB')
                report = json.load(report_file)
            if (not isinstance(report, dict) or set(report) != {'failedNodes', 'selected', 'completed', 'error'} or
                    any(not isinstance(report[key], list) or
                        any(not isinstance(node, str) for node in report[key])
                        for key in ('failedNodes', 'selected', 'completed')) or
                    report['error'] is not None and not isinstance(report['error'], str)):
                raise ValueError('Malformed pytest report')
            failed_nodes = report['failedNodes']
            error = report['error']
            if not report['selected'] or sorted(report['selected']) != sorted(report['completed']):
                error = error or 'Required consumer execution incomplete'
            if manifest['selected'] and sorted(report['selected']) != sorted(manifest['selected']):
                error = error or 'Executed selection differs from assigned retry'
            if not set(failed_nodes).issubset(report['selected']):
                error = error or 'Failures do not belong to the executed selection'
            if code == 0 and (error or failed_nodes):
                code = 1
    except Exception as exception:
        error = f'{type(exception).__name__}: {exception}'
    write_json(run / 'result.json', dict(version=1, runId=run.name, exitCode=code,
               signal=signal, error=error, failedNodes=failed_nodes,
               manifestHash=digest(run / 'manifest.json'),
               inputsUnchanged=inventory(run / 'inputs') == manifest['inputs'], finishedAt=time.time()))


def pytest_run(run):
    import importlib
    manifest = json.loads((run / 'manifest.json').read_text())
    spec = manifest['spec']
    import importlib.metadata
    write_json(run / 'reports' / 'runtime.json', dict(executable=sys.executable, version=sys.version,
               distributions=sorted((item.metadata['Name'], item.version)
                                    for item in importlib.metadata.distributions() if item.metadata['Name'])))
    for module in spec['imports']:
        importlib.import_module(module)
    import pytest

    class Report:
        def __init__(self):
            self.failed = []
            self.selected = []
            self.completed = []
            self.required = []
            self.error = None

        @pytest.hookimpl(hookwrapper=True, tryfirst=True)
        def pytest_collection_modifyitems(self, session, config, items):
            requested = set(manifest['selected'])
            available = {item.nodeid for item in items}
            missing = requested - available
            if missing:
                self.error = f'Recorded consumer IDs missing: {sorted(missing)}'
            self.required = [item.nodeid for item in items if not requested or item.nodeid in requested]
            if requested:
                dropped = [item for item in items if item.nodeid not in requested]
                items[:] = [item for item in items if item.nodeid in requested]
                config.hook.pytest_deselected(items=dropped)
            yield

        def pytest_collection_finish(self, session):
            # session.items is final, after every collection-modification hook.
            # A pre-hook list falsely counted a deselected case as executed.
            self.selected = [item.nodeid for item in session.items]
            if not self.selected or sorted(self.selected) != sorted(self.required):
                self.error = 'Collection changed the required consumer selection'
            if self.error:
                raise pytest.UsageError(self.error)

        def pytest_runtest_logreport(self, report):
            if report.failed and report.nodeid not in self.failed:
                self.failed.append(report.nodeid)
            if report.skipped:
                self.error = f'Required consumer skipped: {report.nodeid}'
            if report.when == 'teardown':
                self.completed.append(report.nodeid)

        def pytest_sessionfinish(self, session, exitstatus):
            if sorted(self.completed) != sorted(self.required):
                self.error = self.error or 'Required consumer execution incomplete'
            if self.error:
                session.exitstatus = pytest.ExitCode.TESTS_FAILED
            write_json(run / 'reports' / 'pytest.json', dict(failedNodes=self.failed,
                       selected=self.selected, completed=self.completed, error=self.error))

    report = Report()
    # The operation's files and recorded retry are the only selectors. Imported
    # setup modules and repository addopts cannot narrow scope or impose fail-fast.
    os.environ.pop('PYTEST_ADDOPTS', None)
    args = [*spec['files'], '-o', 'addopts=', '-k', '', '-m', '', '--maxfail=0',
            '--runxfail', '-vv', '--tb=long', '-p', 'no:cacheprovider']
    for plugin in spec['plugins']:
        args += ['-p', plugin]
    raise SystemExit(pytest.main(args, plugins=[report]))


def main():
    if len(sys.argv) == 3 and sys.argv[1] == 'unchanged':
        run = Path(sys.argv[2])
        manifest = json.loads((run / 'manifest.json').read_text())
        current = {f'{name}/{key}': value for name, source in manifest['spec']['sources'].items()
                   for key, value in inventory(Path(source)).items()}
        raise SystemExit(0 if current == manifest['inputs'] else 1)
    if len(sys.argv) == 3 and sys.argv[1] in ('_execute', '_pytest'):
        {'_execute': execute, '_pytest': pytest_run}[sys.argv[1]](Path(sys.argv[2]))
        return
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    launch = commands.add_parser('start', help='Snapshot and detach one validation; print durable job paths')
    launch.add_argument('spec', type=Path)
    launch.add_argument('jobs', type=Path)
    launch.add_argument('--request-id', help='Controller idempotency key; reattach to the same launch after recovery')
    followup = launch.add_mutually_exclusive_group()
    followup.add_argument('--retry', type=Path, help='Run exactly the previously failed pytest consumers on new inputs')
    followup.add_argument('--full-after', type=Path, help='Run the full suite on the successful retry snapshot')
    args = parser.parse_args()
    start(args.spec.resolve(), args.jobs.resolve(), args.retry, args.full_after, args.request_id)


if __name__ == '__main__':
    main()
