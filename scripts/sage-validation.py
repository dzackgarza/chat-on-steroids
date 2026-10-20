#!/usr/bin/env python3
"""Launch Sage acceptance through the snapshot runner, with explicit dependency roots.

The port and research arguments are source checkouts, including a research worktree
when that is the assigned input. No existing worker or process is stopped. Use the
same jobs directory on every invocation. --retry names a failed run; --full-after
names its successful consumer retry. Output contains the job directory for
workstream action=wait. This is an execution receipt, never an acceptance grant.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('port', 'research', 'vinal', 'qc', 'jobs'):
        parser.add_argument('--' + name, type=Path, required=True)
    for name in ('container', 'sage', 'docker'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--site-packages', action='append', type=Path, required=True,
                        help='Installed dependency directory used by the assigned Sage environment')
    parser.add_argument('--file', action='append', required=True, help='Complete frozen consumer file relative to the port checkout')
    followup = parser.add_mutually_exclusive_group()
    followup.add_argument('--retry', type=Path)
    followup.add_argument('--full-after', type=Path)
    args = parser.parse_args()
    import shlex
    spec = dict(
        sources=dict(port=str(args.port.resolve() / 'src'), tests=str(args.port.resolve() / 'tests'),
                     research=str(args.research.resolve() / 'src'), vinal=str(args.vinal.resolve() / 'src/sage'),
                     qc=str(args.qc.resolve() / 'tool-artifacts/pytest_plugins')),
        cwd='{tests}/..', argv=[args.sage, '-python'],
        env=dict(PYTHONPATH='{port}:{tests}/..:{research}:{vinal}:{qc}:' +
                 ':'.join(str(directory.resolve()) for directory in args.site_packages), PYTHONNOUSERSITE='1'),
        transport=['/usr/bin/sg', 'docker', '-c',
                   shlex.join([args.docker, 'exec', '-d', '-u', 'root', args.container]) + ' {runner}'],
        mode='pytest', files=args.file, imports=['sage.all'], plugins=['qc_sage_session'])
    args.jobs.mkdir(parents=True, exist_ok=True)
    request = args.jobs.resolve() / ('request-' + str(uuid.uuid4()) + '.json')
    request.write_text(json.dumps(spec, indent=2) + '\n')
    command = [sys.executable, str(Path(__file__).with_name('validation-run.py')), 'start', str(request), str(args.jobs.resolve())]
    if args.retry:
        command += ['--retry', str(args.retry.resolve())]
    if args.full_after:
        command += ['--full-after', str(args.full_after.resolve())]
    raise SystemExit(subprocess.call(command))


if __name__ == '__main__':
    main()
