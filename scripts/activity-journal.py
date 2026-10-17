#!/usr/bin/env python3
"""Read-only workstream activity monitor over Core2's recorder and status API.

Rich provides the terminal layout. This file only extracts meaningful activity
from existing records and reports the controller's observed state; it never
changes a workstream, sends messages, or operates on the browser.
"""
import argparse
from datetime import datetime
import hashlib
import json
import re
from pathlib import Path
import sys
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

try:
    from rich.console import Console
    from rich.live import Live
    from rich.table import Table
    from rich.text import Text
except ImportError:
    Console = Live = Table = Text = None  # Plain/pipe mode remains available.

def moment(ms):
    return datetime.fromtimestamp(ms / 1000).astimezone().strftime("%m-%d %H:%M:%S")

def age(ms):
    s = max(0, int(ms / 1000))
    if s < 60: return f"{s}s"
    if s < 3600: return f"{s // 60}m{s % 60:02d}s"
    return f"{s // 3600}h{(s // 60) % 60:02d}m"

def short(s, n=115):
    text = " ".join(str(s or "").split())
    return text[:n - 1] + "…" if len(text) > n else text

def exit_code(result):
    m = re.search(r"Process exited with code (-?\d+)", result or "")
    return int(m.group(1)) if m else None

def pid_of(result):
    m = re.search(r"Process running with session ID (\d+)", result or "")
    return m.group(1) if m else None

def poll_pid(call):
    try: return str(json.loads(call.get("args", {}).get("text") or "{}")["session_id"])
    except (ValueError, KeyError, TypeError): return None

def inspection(tool, title):
    if tool in ("read", "find", "session", "view_image"): return True
    if tool != "exec_command": return False
    if re.search(r"\b(pytest|test[-_]|git commit|git push|git add|make|build|sed -i|tee\b|cat\s*>|>>|python3?\s*>)", title, re.I): return False
    return bool(re.match(r"^(Ran|Started) (sed -n|rg|grep|find|ls|head|tail|wc|pwd|date|ps|git rev-parse|git branch|git status|git log|git show|git diff)(?:\s|$)", title))

class Session:
    def __init__(self, folder, title, name):
        self.folder, self.title, self.name = folder, title, name
        self.offset = 0
        self.shards = {}
        self.processes = {}
        self.routine = []
        self.last = None
        self.last_signal = 0
        # Includes recorder calls suppressed from the timeline (e.g. process polls).
        self.last_tool = None

    def projection(self, row, *, verbose=False, trace=False):
        stamp = row.get("time")
        if not isinstance(stamp, (float, int)) or stamp <= 0: return None
        stamp = int(stamp)
        self.last_signal = max(stamp, self.last_signal)
        kind = row.get("kind")
        name = self.name
        severity = "info"
        if kind == "tool_call":
            c = row.get("call") or {}
            tool = c.get("tool", "")
            title = str((c.get("summary") or {}).get("title") or tool)
            if tool == "exec_command" and title in ("Ran a command", "Started a command", "exec_command"):
                # Batched commands sometimes receive a generic recorder title.
                # Show the first command rather than leaving the user with "a command".
                try:
                    arguments = json.loads((c.get("args") or {}).get("text") or "{}")
                    commands = arguments.get("cmd") or arguments.get("cmds") or ""
                    command = commands[0] if isinstance(commands, list) and commands else commands
                    if isinstance(command, str) and command.strip():
                        command = re.sub(r"(?i)(Bearer\s+)\S+", r"\1***", command)
                        command = re.sub(r"sk-[A-Za-z0-9_-]{8,}", "sk-***", command)
                        command = re.sub(r"\b[A-Za-z0-9_-]{40,}\b", "***", command)
                        title = f"{'Started' if title.startswith('Started') else 'Ran'} {short(command, 140)}"
                        if isinstance(commands, list) and len(commands) > 1:
                            title += f" (+{len(commands) - 1} commands)"
                except (TypeError, ValueError):
                    pass
            name = c.get("workstreamId") or name
            output = str((c.get("result") or {}).get("text") or "")
            outcome = c.get("outcome")
            duration = int(c.get("durationMs") or 0)
            label = re.sub(r"^(Ran|Started) ", "", title)
            if tool == "write_stdin":
                process = poll_pid(c)
                source = self.processes.get(process)
                code = exit_code(output)
                if source:
                    label = f"{short(source, 105)} · " + (f"exit {code}" if code is not None else "process poll")
                else:
                    label = f"process session {process or '?'} · " + (f"exit {code}" if code is not None else "polled")
            elif tool == "exec_command":
                code = exit_code(output)
                if code is not None:
                    label += f" · exit {code}"
                elif pid_of(output):
                    label += " · process running"
            self.last_tool = (stamp, tool, short(label, 155), str(outcome or "?"))
            if tool == "write_stdin":
                pid = poll_pid(c)
                code = exit_code(output)
                if code is None and outcome == "ok":
                    return ("POLL", name, stamp, f"Process session {pid or '?'} polled", "muted") if trace else None
                known_process = pid in self.processes
                source = self.processes.pop(pid, f"session {pid}") if pid else "process"
                severity = "error" if code not in (0, None) or outcome != "ok" else "success"
                if severity == "success" and not verbose and (
                    not known_process
                    or source.startswith(("itree next ", "Source inspection: "))
                ):
                    # A successful wait for an untracked process proves no
                    # user-meaningful work; the launch may predate our history
                    # window. Its exit number alone is not an activity headline.
                    return None
                detail = f"{short(source, 110)} · exit {code}" if code is not None else f"{short(source)} · terminal tool error"
                if severity == "error":
                    m = re.search(r"(?m)^(FAILED\b.{0,100}|ERROR[: ].{0,100}|Error:.{0,100})$", output)
                    if m: detail += f" · {short(m.group(1), 100)}"
                return ("FAIL" if severity == "error" else "FINISH", name, stamp, detail, severity)
            args_text = (c.get("args") or {}).get("text") or ""
            selects_issue = tool == "exec_command" and "itree next" in (args_text + title)
            if tool == "exec_command" and selects_issue and outcome == "ok" and not verbose:
                pending = pid_of(output)
                if pending:
                    match = re.search(r"\bitree next\s+([\w./-]+)", args_text)
                    self.processes[pending] = f"itree next {match.group(1) if match else '(repository)'}"
                self.routine.append((stamp, "selection", ""))
                return None
            if inspection(tool, title) and outcome == "ok" and not verbose:
                pending = pid_of(output) if tool == "exec_command" else None
                if pending:
                    self.processes[pending] = f"Source inspection: {short(title, 95)}"
                self.routine.append((stamp, "inspection", short(title.replace("Ran ", ""), 90)))
                return None
            if tool == "exec_command":
                detail = re.sub(r"^(Ran|Started) ", "", title)
                if re.search(r"pytest|test[-_]|sage -python", detail, re.I): action = "TEST"
                elif re.search(r"\bgit commit\b", detail): action = "COMMIT"
                elif re.search(r"\bgit push\b", detail): action = "PUSH"
                else: action = "COMMAND"
                session_id = pid_of(output)
                if session_id:
                    self.processes[session_id] = detail
                    detail += f" · spawned session {session_id}"
                else:
                    code = exit_code(output)
                    if code is not None:
                        detail += f" · exit {code}"
                        if code != 0: outcome = "error"
            elif tool == "apply_patch":
                action = "EDIT"
                changes = c.get("changes") or []
                detail = ", ".join(Path(x.get("path") or x.get("file") or "").name for x in changes if isinstance(x, dict)) or title
            elif tool == "agents":
                action, detail = "WORKERS", title
            else:
                action, detail = tool.upper().replace("_", " "), title
            if outcome != "ok":
                action, severity = "FAIL " + action, "error"
                detail += f" · {short(next((line for line in output.splitlines() if line.strip() and not line.startswith(('Chunk ID:', 'Wall time:', 'Original token count:'))), ''), 85)}"
            elif action in ("EDIT", "COMMIT", "PUSH"):
                severity = "success"
            detail = short(detail, 155)
            # Recorded time is MCP ingress (tool start); the duration establishes its end.
            if duration >= 1000: detail += f" · {age(duration)} call"
            return (action, name, stamp, detail, severity)
        if kind == "turn_start":
            if not verbose:
                self.routine.append((stamp, "turn-start", ""))
                return None
            return ("TURN START", name, stamp, "ChatGPT began generating (page-observed)", "info")
        if kind == "turn_end":
            outcome = row.get("outcome") or "unknown"
            if not verbose and outcome == "completed":
                self.routine.append((stamp, "turn-end", ""))
                return None
            return ("TURN END", name, stamp, f"Outcome: {outcome}", "success" if outcome == "completed" else "warn")
        if kind == "chat_error":
            return ("CHAT ERROR", name, stamp, short((row.get("message") or {}).get("text"), 150), "error")
        if kind == "agent_message":
            if row.get("delivery") == "delivered" and not verbose: return None
            return ("AGENT MESSAGE", name, stamp, f"{row.get('from','?')} → {row.get('to','?')}: {short((row.get('message') or {}).get('text'), 120)}", "info")
        if kind == "assistant_message":
            msg = (row.get("message") or {}).get("text") or ""
            if msg.startswith("::") or not msg: return None
            if row.get("state") == "final" or row.get("final") is True or verbose:
                return ("AGENT SAYS", name, stamp, short(msg, 155) + " [not independently verified]", "muted")
        if kind == "progress":
            msg = (row.get("message") or {}).get("text") or ""
            if msg and not msg.startswith("::"):
                return ("COMMENTARY", name, stamp, short(msg, 145), "muted")
        if kind == "handoff":
            return ("HANDOFF", name, stamp, short(row.get("reason") or "Conversation continued", 120), "info")
        return None

    def drain_routine(self, stamp, *, force=False):
        rows = self.routine
        if not rows or (not force and stamp - rows[0][0] < 180_000):
            return None
        self.routine = []
        counts = {kind: sum(value == kind for _, value, _ in rows)
                  for kind in {x[1] for x in rows}}
        starts = counts.get("turn-start", 0)
        completed = counts.get("turn-end", 0)
        selected = counts.get("selection", 0)
        reads = counts.get("inspection", 0)
        parts = []
        if starts or completed: parts.append(f"turns {starts} started / {completed} completed")
        if selected: parts.append(f"selected ready issue {selected}×")
        if reads:
            files = list(dict.fromkeys(short(detail, 50) for _, kind, detail in rows if kind == "inspection"))
            parts.append(f"{reads} inspections ({short(', '.join(files[-2:]), 90)})")
        first, last = rows[0][0], rows[-1][0]
        period = (f"{moment(first)[6:]}–{moment(last)[6:]}" if last > first else moment(first)[6:])
        parts.append(period)
        return ("ISSUE CYCLE" if selected else "ACTIVITY", self.name, last, " · ".join(parts),
                "warn" if selected >= 4 and not reads else "muted")

    def scan(self, cutoff, *, verbose, trace):
        result = []
        file = self.folder / "events.jsonl"
        try:
            if file.stat().st_size < self.offset: self.offset = 0
            with file.open("rb") as stream:
                stream.seek(self.offset)
                while line := stream.readline():
                    if not line.endswith(b"\n"): break  # wait for complete append
                    self.offset = stream.tell()
                    try:
                        event = self.projection(json.loads(line), verbose=verbose, trace=trace)
                        if event and event[2] >= cutoff:
                            routine = self.drain_routine(event[2], force=True)
                            if routine: result.append(routine)
                            result.append(event)
                        elif self.routine:
                            routine = self.drain_routine(self.last_signal)
                            if routine and routine[2] >= cutoff: result.append(routine)
                    except (ValueError, OverflowError, TypeError):
                        continue
        except FileNotFoundError:
            pass
        for shard in (self.folder / "messages").glob("*.json"):
            try:
                stat = shard.stat()
                marker = (stat.st_mtime_ns, stat.st_size)
                old = self.shards.get(shard)
                if old and old[:2] == marker: continue
                data = shard.read_bytes()
                digest = hashlib.blake2s(data, digest_size=8).digest()
                if old and old[2] == digest:
                    self.shards[shard] = (*marker, digest)
                    continue
                row = json.loads(data)
                self.shards[shard] = (*marker, digest)
                if old: row["time"] = stat.st_mtime_ns // 1_000_000
                event = self.projection(row, verbose=verbose, trace=trace)
                if event and event[2] >= cutoff: result.append(event)
            except (OSError, ValueError, TypeError, OverflowError):
                continue
        routine = self.drain_routine(self.last_signal)
        if routine and routine[2] >= cutoff: result.append(routine)
        if result: self.last = max(result, key=lambda e:e[2])
        return result

class Recorder:
    def __init__(self, root, cutoff, chat, verbose, trace):
        self.root, self.cutoff, self.chat = root, cutoff, chat.casefold()
        self.verbose, self.trace = verbose, trace
        self.sessions, self.by_name, self.by_id = {}, {}, {}

    def poll(self):
        events = []
        for meta_file in self.root.glob("*/meta.json"):
            folder = meta_file.parent
            s = self.sessions.get(folder)
            if s is None:
                try:
                    meta = json.loads(meta_file.read_text())
                    title = str(meta.get("title") or folder.name)
                    name = title.removeprefix("Workstream · ").strip() if title.startswith("Workstream · ") else title
                    if self.chat and self.chat not in (name + " " + folder.name).casefold(): continue
                    if self.cutoff and max(meta_file.stat().st_mtime, (folder/"events.jsonl").stat().st_mtime)*1000 < self.cutoff: continue
                    s = self.sessions[folder] = Session(folder, title, name)
                    self.by_id[folder.name] = s
                    self.by_name[name] = s
                except (ValueError, OSError, TypeError):
                    continue
            events.extend(s.scan(self.cutoff, verbose=self.verbose, trace=self.trace))
        return sorted(events, key=lambda e:(e[2],e[1],e[0]))

class Controller:
    def __init__(self, root, enabled=True):
        self.enabled, self.rows, self.calls, self.chats, self.error = enabled, [], [], {}, None
        self.port = None
        try: self.token = (root/"local-token").read_text().strip() if enabled else ""
        except OSError: self.token = ""

    def get(self, suffix):
        if not self.token: raise OSError("Core2 local token unavailable")
        ports = [self.port] if self.port else range(8765, 8770)
        last_error = None
        for port in ports:
            try:
                request = Request(f"http://127.0.0.1:{port}{suffix}", headers={"Authorization":f"Bearer {self.token}"})
                with urlopen(request, timeout=1.25) as response: result = json.load(response)
                self.port = port
                return result
            except (OSError, ValueError) as err:
                last_error = err
        self.port = None
        raise OSError(f"Controller unavailable: {last_error}")

    def poll(self, chat=""):
        if not self.enabled: return
        try:
            rows = self.get("/workstreams").get("workstreams") or []
            calls = self.get("/sleep/status").get("inFlightCalls") or []
            chats = {}
            for r in sorted(rows, key=lambda x:x.get("lastActivity") or 0, reverse=True):
                if len(chats) >= 10: break
                conv = r.get("conversationId")
                if not conv or r.get("phase")=="paused" or (chat and chat.casefold() not in r.get("id","").casefold()):continue
                chats[r["id"]] = self.get("/conversation/status?" + urlencode({"conversationId":conv}))
            self.rows, self.calls, self.chats, self.error = rows, calls, chats, None
        except (OSError, ValueError) as err:
            self.error = short(err, 110)

def current_state(row, controller, session, now):
    name, phase = row["id"], row.get("phase","?")
    last = max(int(row.get("lastActivity") or 0), session.last_signal if session else 0)
    if session and session.last_tool:
        called_at, method, summary, outcome = session.last_tool
        recent = f"{moment(called_at)[6:]} {method} · {short(summary, 105)} ({outcome})"
    else:
        recent = "No recorded tool call"

    def showing(context):
        return f"{recent}\n{context}"

    inflight = [x for x in controller.calls if x.get("workstreamId")==name]
    if inflight:
        call = max(inflight, key=lambda x:x.get("ageMs") or 0)
        started = now - int(call.get("ageMs") or 0)
        phase_note = f" · phase {phase}" if phase != "active" else ""
        return (name, "TOOL RUNNING", showing(f"In flight: {call.get('tool','tool')} since {moment(started)[6:]} ({age(now-started)}){phase_note}"), max(last,started), "tool")
    if phase in ("paused","blocked","recovering","archiving","opening"):
        return (name, phase.upper(), showing(short(row.get("error") or phase, 85)), last, phase)
    chat = controller.chats.get(name) or {}
    if chat.get("generating") is True:
        observed = max(int(chat.get("lastStoredAt") or 0),int(chat.get("lastContactAt") or 0))
        silence = now-observed if observed else now-last
        started = int(chat.get("turnStartedAt") or 0)
        detail = showing(f"Open turn {age(now-started) if started else '?'}; page observation {age(silence)} ago")
        if silence >=300000:return(name,"NO SIGNAL",detail,max(last,observed),"no-signal")
        if silence >=90000:return(name,"QUIET TURN",detail,max(last,observed),"quiet")
        return (name,"GENERATING",detail,max(last,observed),"generating")
    if chat.get("known") is True and chat.get("generating") is False:
        last = max(last,int(chat.get("lastStoredAt") or 0))
        if last and now-last>=300000:
            return (name,"INACTIVE",showing(f"No new observation for {age(now-last)}"),last,"inactive")
        return (name,"IDLE",showing("No generating turn or tool in flight"),last,"idle")
    if phase == "advancing":
        return (name,"ADVANCING",showing("Next turn scheduled"),last,"advancing")
    if last and now-last>=300000:
        return(name,"NOT OBSERVED",showing(f"No admitted call for {age(now-last)}; no proven live turn"),last,"unobserved")
    if row.get("conversationId"):
        return(name,"PAGE UNKNOWN",showing("Browser turn state unavailable"),last,"unknown")
    return(name,"UNBOUND",showing("No bound ChatGPT conversation"),last,"unbound")

def states(recorder, controller, now, chat, show_paused):
    if not controller.rows:
        return [(n,"OFFLINE","Recorder history only; controller unavailable",s.last_signal,"offline") for n,s in recorder.by_name.items() if s.last_signal >= recorder.cutoff][:12]
    out = []
    for r in sorted(controller.rows,key=lambda x:x.get("lastActivity") or 0,reverse=True):
        name = r.get("id","")
        if chat and chat.casefold() not in name.casefold(): continue
        if r.get("phase")=="paused" and not show_paused: continue
        if r.get("phase") not in ("blocked","recovering","archiving","advancing","opening") and r.get("lastActivity",0)<recorder.cutoff and name not in recorder.by_name:continue
        s = recorder.by_id.get(r.get("sessionId")) or recorder.by_name.get(name)
        out.append(current_state(r,controller,s,now))
        if len(out)>=12 and not chat: break
    return out

def render_event(console, record, use_rich):
    kind, name, when, detail, tone = record
    if not use_rich:
        print(f"{moment(when)}  {name[:28]:28} {kind:13} {detail}", flush=True)
        return
    col = {"success":"green","error":"bold red","warn":"yellow","muted":"dim"}.get(tone,"cyan")
    line=Text(f"{moment(when)}  ",style="dim")
    line.append(f"{name[:27]:27}  ",style="bold")
    line.append(f"{kind[:13]:13} ",style=col)
    # Rich is the terminal renderer; keep each timeline entry on one physical
    # line so a busy stream never displaces the status table with wrapped text.
    available=max(24,console.width-68)
    line.append(short(detail,available),style="dim" if tone=="muted" else "")
    console.print(line,overflow="ellipsis",soft_wrap=False)

def status_table(rows, error):
    table=Table(expand=True,box=None,show_edge=False,padding=(0,1),header_style="bold")
    table.add_column("Workstream",no_wrap=True,ratio=2)
    table.add_column("State",no_wrap=True,ratio=1)
    table.add_column("Current activity",ratio=5,overflow="ellipsis")
    table.add_column("Last seen",no_wrap=True,justify="right")
    now=int(time.time()*1000)
    for name,state,desc,last,bucket in rows:
        color=("green" if bucket in ("tool","generating") else
               "yellow" if bucket in ("quiet","no-signal","blocked","unobserved","recovering") else "dim")
        table.add_row(name,Text(state,style=color),desc,age(now-last) if last else "—")
    if not rows:table.add_row("—","NONE","Waiting for workstream evidence","—")
    table.title=f"Workstream activity · {datetime.now().astimezone().strftime('%H:%M:%S %Z')}" + (" · Controller unavailable" if error else "")
    return table

def run():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root",type=Path,required=True)
    parser.add_argument("--state-dir",type=Path)
    parser.add_argument("--hours",type=float,default=3)
    parser.add_argument("--lines",type=int,default=80)
    parser.add_argument("--chat",default="")
    parser.add_argument("--interval",type=float,default=3)
    parser.add_argument("--verbose",action="store_true",help="show each source read/search")
    parser.add_argument("--trace",action="store_true",help="also show process polls")
    parser.add_argument("--plain",action="store_true",help="plain journalctl-style lines, no pinned status panel")
    parser.add_argument("--no-controller",action="store_true",help="recorder history only")
    parser.add_argument("--all",action="store_true",help="include paused workstreams")
    parser.add_argument("--no-follow",action="store_true")
    a=parser.parse_args()
    if not a.root.is_dir():parser.error("Recorder directory unavailable")
    if a.hours<0 or a.lines<0 or a.interval<=0:parser.error("hours/lines must be nonnegative and interval positive")
    cutoff=int((time.time()-a.hours*3600)*1000) if a.hours else 0
    recorder=Recorder(a.root,cutoff,a.chat,a.verbose,a.trace)
    controller=Controller(a.state_dir or a.root.parent/"state",enabled=not a.no_controller)
    rich=Console is not None and sys.stdout.isatty() and not a.plain
    console=Console(highlight=False) if rich else None

    def update(prev,monitored):
        for state in monitored:
            old=prev.get(state[0])
            if old and old[4]!=state[4] and (state[4] in ("quiet","no-signal","unobserved","inactive","blocked","recovering","archiving") or old[4] in ("quiet","no-signal","unobserved","inactive")):
                render_event(console,("STATE",state[0],int(time.time()*1000),f"{state[1]} · {state[2]}","warn"),rich)
        return {x[0]:x for x in monitored}

    initial=recorder.poll()
    controller.poll(a.chat)
    monitored=states(recorder,controller,int(time.time()*1000),a.chat,a.all)
    live=Live(status_table(monitored,controller.error),console=console,auto_refresh=False,transient=False) if rich else None
    try:
        if live: live.__enter__()
        for event in (initial[-a.lines:] if a.lines else initial):render_event(console,event,rich)
        if not rich:
            for row in monitored:render_event(console,(row[1],row[0],int(time.time()*1000),row[2],"warn" if row[4] in ("blocked","no-signal","quiet","unobserved") else "info"),False)
        if a.no_follow:return
        previous={x[0]:x for x in monitored}
        previous_error=controller.error
        last_heartbeat=time.monotonic()
        while True:
            time.sleep(a.interval)
            for event in recorder.poll():render_event(console,event,rich)
            controller.poll(a.chat)
            monitored=states(recorder,controller,int(time.time()*1000),a.chat,a.all)
            previous=update(previous,monitored)
            if bool(previous_error)!=bool(controller.error):
                render_event(console,("MONITOR","Core2",int(time.time()*1000),"Controller unavailable; recorder activity only" if controller.error else "Controller reconnected","warn" if controller.error else "success"),rich)
            previous_error=controller.error
            if live:live.update(status_table(monitored,controller.error),refresh=True)
            elif time.monotonic()-last_heartbeat>=60:
                for row in monitored:render_event(console,(row[1],row[0],int(time.time()*1000),row[2],"warn" if row[4] in ("blocked","no-signal","quiet","unobserved") else "info"),False)
                last_heartbeat=time.monotonic()
    except (KeyboardInterrupt,BrokenPipeError):
        pass
    finally:
        if live:live.__exit__(None,None,None)

if __name__=="__main__":
    run()
