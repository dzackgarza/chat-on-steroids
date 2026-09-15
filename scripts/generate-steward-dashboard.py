#!/usr/bin/env python3
from __future__ import annotations
import argparse, csv, datetime as dt, html, json, math, os, re, statistics, subprocess
from pathlib import Path

ROOT = Path('/home/dzack/gitclones/chat-on-steroids')
REPOS = {
    'research': Path('/home/dzack/research'),
    'lean-categories': Path('/home/dzack/gitclones/lean-categories'),
    'new-qual-site': Path('/home/dzack/gitclones/new-qual-site'),
    'sage-categories': Path('/home/dzack/gitclones/sage-categories'),
}
GLOSSARY = {
    'frontier': 'The next repository-defined work that is eligible after dependency and phase rules are applied.',
    'ready node': 'A DAG task whose listed prerequisites are already closed.',
    'residue': 'Items still lacking an accepted reuse/reference route after an earlier search pass; not permission to invent them.',
    'Milestone 1': 'Lean-categories gate where definitional prior-art search is exhausted before definition implementation begins.',
    'terminal audit': 'A permanent post-feature review loop that rotates independent quality lenses and may legitimately make no commit.',
    'Queue C': 'new-qual-site generated list of problem cards that currently lack a solution.',
    'Queue E': 'new-qual-site PDF-source intake list; an unchecked row can be source-locally blocked without blocking solution writing.',
}

def run(repo: Path, *args: str, check=True) -> str:
    p = subprocess.run(args, cwd=repo, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and p.returncode:
        raise RuntimeError(f"{' '.join(args)}: {p.stderr.strip()}")
    return p.stdout

def git(repo: Path, *args: str, check=True) -> str:
    return run(repo, 'git', *args, check=check)

def parse_iso(s: str) -> dt.datetime:
    return dt.datetime.fromisoformat(s.replace('Z', '+00:00'))

def commits(repo: Path, days=7, limit=300):
    fmt = '%H%x1f%aI%x1f%an%x1f%ae%x1f%s%x1e'
    raw = git(repo, 'log', f'--since={days} days ago', f'-n{limit}', f'--format={fmt}', '--numstat')
    out=[]
    for block in raw.split('\x1e'):
        block=block.strip('\n')
        if not block.strip(): continue
        lines=block.splitlines(); meta=lines[0].split('\x1f')
        if len(meta)<5: continue
        ins=dele=files=0
        for line in lines[1:]:
            parts=line.split('\t')
            if len(parts)>=3:
                files+=1
                if parts[0].isdigit(): ins += int(parts[0])
                if parts[1].isdigit(): dele += int(parts[1])
        out.append({'hash':meta[0][:9],'time':meta[1],'author':meta[2],'email':meta[3],'subject':meta[4],
                    'files':files,'insertions':ins,'deletions':dele})
    return out

def hourly(commits_, hours=48):
    now=dt.datetime.now(dt.timezone.utc); start=now-dt.timedelta(hours=hours)
    vals=[0]*hours
    for c in commits_:
        t=parse_iso(c['time']).astimezone(dt.timezone.utc)
        k=int((t-start).total_seconds()//3600)
        if 0 <= k < hours: vals[k]+=1
    ew=[]; x=0.0
    for v in vals:
        x=.35*v+.65*x; ew.append(round(x,3))
    return [{'t':(start+dt.timedelta(hours=i)).isoformat(),'n':v,'ewma':ew[i]} for i,v in enumerate(vals)]

def mark_terms(text: str) -> str:
    escaped=html.escape(text)
    for term in sorted(GLOSSARY, key=len, reverse=True):
        escaped=escaped.replace(term, f"<span class='gloss' data-g='{html.escape(term)}'>{html.escape(term)}</span>")
    return escaped

def age_label(iso: str) -> str:
    delta=dt.datetime.now(dt.timezone.utc)-parse_iso(iso).astimezone(dt.timezone.utc)
    minutes=max(0, round(delta.total_seconds()/60))
    if minutes < 60: return f'{minutes}m'
    if minutes < 1440: return f'{round(minutes/60)}h'
    return f'{round(minutes/1440)}d'

def recent_files(repo: Path, limit=30):
    names=git(repo,'ls-files','-co','--exclude-standard').splitlines(); rows=[]
    for name in names:
        p=repo/name
        try: st=p.stat()
        except OSError: continue
        rows.append((st.st_mtime, name, st.st_size))
    rows.sort(reverse=True)
    return [{'time':dt.datetime.fromtimestamp(t,dt.timezone.utc).isoformat(),'path':n,'bytes':z} for t,n,z in rows[:limit]]

def dirty(repo: Path):
    lines=git(repo,'status','--short').splitlines(); c={}
    for line in lines:
        code=line[:2]; c[code]=c.get(code,0)+1
    return {'count':len(lines),'by_status':c}

def checkbox_dag(path: Path):
    text=path.read_text(errors='replace').splitlines(); nodes=[]
    pat=re.compile(r'^- \[([ x])\] \*\*`([^`]+)`\*\*\. \*\*Needs:\*\* (.*)')
    for i,line in enumerate(text):
        m=pat.match(line)
        if not m: continue
        closed=m.group(1)=='x'; id_=m.group(2); tail=m.group(3)
        needs=[] if re.match(r'none\.?$', tail.strip()) else re.findall(r'`([^`]+)`',tail.split('.',1)[0])
        body=[line]
        j=i+1
        while j<len(text) and not pat.match(text[j]) and not re.match(r'^#{1,4} ',text[j]):
            if text[j].strip(): body.append(text[j])
            j+=1
        acceptance=' '.join(x.strip() for x in body if '**Acceptance:**' in x)
        nodes.append({'id':id_,'closed':closed,'needs':needs,'text':' '.join(x.strip() for x in body)[:1400], 'acceptance':acceptance[:900]})
    return nodes

def table_dag(path: Path):
    nodes=[]
    for line in path.read_text(errors='replace').splitlines():
        if not line.startswith('| `'): continue
        cols=[x.strip() for x in line.strip().strip('|').split('|')]
        if len(cols)<3: continue
        id_=cols[0].strip('`'); desc=cols[1]; needs=re.findall(r'`([^`]+)`',cols[2])
        closed=('**Closed' in desc or '**Completed' in desc or 'Completed ' in desc)
        acc=''
        m=re.search(r'\*\*Acceptance:\*\*(.*)',desc)
        if m: acc=m.group(1).strip()
        nodes.append({'id':id_,'closed':closed,'needs':needs,'text':re.sub(r'\*+','',desc)[:1400], 'acceptance':acc[:900]})
    return nodes

def process_rows(repo: Path):
    rows=[]
    for e in os.listdir('/proc'):
        if not e.isdigit(): continue
        p=Path('/proc')/e
        try:
            cwd=Path(os.readlink(p/'cwd'))
            if cwd != repo and repo not in cwd.parents: continue
            cmd=(p/'cmdline').read_bytes().replace(b'\0',b' ').decode(errors='replace').strip()
            stat=(p/'stat').read_text().split()[2]
        except Exception: continue
        if cmd: rows.append({'pid':int(e),'state':stat,'cwd':str(cwd.relative_to(repo)) if cwd!=repo else '.', 'cmd':cmd[:240]})
    return rows[:40]

def open_ready(nodes):
    openids={n['id'] for n in nodes if not n['closed']}
    for n in nodes:
        n['ready']=(not n['closed']) and all(x not in openids for x in n['needs'])
    return {'open':sum(not n['closed'] for n in nodes), 'closed':sum(n['closed'] for n in nodes), 'ready':sum(n.get('ready',False) for n in nodes)}

def theil_sen(points):
    # points: (hours_from_start, remaining), robust median slope
    if len(points)<3: return None
    slopes=[]
    for i in range(len(points)):
        for j in range(i+1,len(points)):
            dx=points[j][0]-points[i][0]
            if dx>0: slopes.append((points[j][1]-points[i][1])/dx)
    if not slopes: return None
    slope=statistics.median(slopes)
    intercept=statistics.median([y-slope*x for x,y in points])
    mad=statistics.median([abs(s-slope) for s in slopes]) if len(slopes)>2 else 0
    return slope,intercept,mad

def lean_progress(repo: Path):
    p=repo/'FOUNDATIONAL_DEFINITIONS.tsv'; rows=[]
    with p.open(newline='') as f:
        rows=list(csv.DictReader(f,delimiter='\t'))
    by={}
    for r in rows:
        src=r.get('source_id',''); by.setdefault(src,{}); a=r.get('action','')
        by[src][a]=by[src].get(a,0)+1
    return {'label':'Definition mapping worklist', 'definition':'Rows in the generated definitional index, grouped by current action. “search” is first-pass source adjudication; “residue-search” is later prior-art search.', 'sources':by}

def nq_progress(repo: Path):
    q=(repo/'queues/C-unsolved-cards.md').read_text(errors='replace')
    ids=set(re.findall(r'\b(?:P|E)-[A-Za-z0-9_.-]+\b',q))
    e=(repo/'queues/E-pdf-attachments.md').read_text(errors='replace').splitlines()
    open_e=[x for x in e if x.startswith('- [ ]')]
    blocked=sum('BLOCKED' in x for x in open_e)
    return {'label':'Unsolved problem queue', 'definition':'Queue C card IDs are problems currently lacking a solution. Queue E is PDF intake; blocked rows are source-local and do not block solution writing.', 'unsolved':len(ids),'queue_e_open':len(open_e),'queue_e_blocked':blocked,'queue_e_executable':len(open_e)-blocked}

def historical_nq(repo: Path, commits_):
    # sample at most one revision per hour for last 36h; derive queue C size when file exists
    picks={}
    now=dt.datetime.now(dt.timezone.utc)
    for c in commits_:
        t=parse_iso(c['time']).astimezone(dt.timezone.utc)
        age=(now-t).total_seconds()/3600
        if 0<=age<=36:
            key=int(age); picks.setdefault(key,c['hash'])
    pts=[]
    for key,h in sorted(picks.items(),reverse=True):
        raw=git(repo,'show',f'{h}:queues/C-unsolved-cards.md',check=False)
        if not raw: continue
        n=len(set(re.findall(r'\b(?:P|E)-[A-Za-z0-9_.-]+\b',raw)))
        pts.append((36-key,n,h))
    fit=theil_sen([(x,y) for x,y,_ in pts])
    proj=None
    if fit and fit[0] < -0.05:
        current=pts[-1][1] if pts else None
        eta=current/(-fit[0]) if current is not None else None
        proj={'slope_per_hour':fit[0],'eta_hours':eta,'slope_mad':fit[2]}
    return {'series':[{'x':x,'remaining':y,'rev':h} for x,y,h in pts],'projection':proj}

def repo_payload(name, repo, classification):
    cs=commits(repo)
    dag=checkbox_dag(repo/'TODO.md') if name in ('research','new-qual-site') else table_dag(repo/'TODO.md')
    summary=open_ready(dag)
    progress={}
    hist={}
    if name=='lean-categories': progress=lean_progress(repo)
    elif name=='new-qual-site': progress=nq_progress(repo); hist=historical_nq(repo,cs)
    elif name=='research': progress={'label':'Complaint-remediation DAG','definition':'Open/ready task counts from TODO.md. A ready task has no remaining open prerequisite.', **summary}
    else: progress={'label':'Remediation/audit DAG','definition':'Open/ready task counts from TODO.md. The terminal audit is permanent and is not an ETA-bearing backlog.', **summary}
    return {'name':name,'path':str(repo),'head':git(repo,'rev-parse','--short','HEAD').strip(), 'classification':classification,
            'dirty':dirty(repo),'processes':process_rows(repo),'commits':cs[:40],'hourly':hourly(cs),'files':recent_files(repo),
            'dag':dag,'dag_summary':summary,'progress':progress,'history':hist}

CSS='''
:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#18212b;background:#f5f6f7}*{box-sizing:border-box}body{margin:0}.wrap{max-width:1600px;margin:auto;padding:14px}.top{display:flex;justify-content:space-between;align-items:end;gap:12px;margin-bottom:10px}.muted{color:#687380}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.repo{background:white;border:1px solid #dfe3e6;border-radius:10px;overflow:hidden}.rh{display:grid;grid-template-columns:1fr auto auto;gap:10px;padding:10px 12px;border-bottom:1px solid #e7eaed}.state{font-weight:700}.working{color:#146c43}.wedged,.blocked,.drifting{color:#9a4b00}.done{color:#52606d}.bands{display:grid;grid-template-columns:1.2fr 1fr;gap:10px;padding:10px}.panel{min-width:0}.title{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#687380;margin:0 0 5px}.chart{height:94px}.chart svg{width:100%;height:100%;overflow:visible}.tiny{font-size:11px}.metric{font-size:24px;font-variant-numeric:tabular-nums}.tail{max-height:180px;overflow:auto;border-top:1px solid #edf0f2}.row{display:grid;grid-template-columns:88px 1fr auto;gap:8px;padding:4px 10px;border-bottom:1px solid #f0f2f3;font-size:11px}.row .time{font-variant-numeric:tabular-nums;color:#687380}.row .subj{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dagbox{height:230px;border-top:1px solid #edf0f2;position:relative}.dagbox svg{width:100%;height:100%;touch-action:none}.tip{position:fixed;z-index:10;max-width:440px;padding:8px 10px;border-radius:7px;background:#17202a;color:white;font-size:11px;pointer-events:none;opacity:0}.gloss{border-bottom:1px dotted #566;cursor:help}.pill{font-size:11px;padding:2px 6px;border:1px solid #ccd3d8;border-radius:999px}.legend{display:flex;gap:8px;flex-wrap:wrap;font-size:11px}.foot{font-size:11px;color:#687380;margin-top:10px}@media(max-width:900px){.grid{grid-template-columns:1fr}.bands{grid-template-columns:1fr}.rh{grid-template-columns:1fr auto}.rh>:nth-child(3){grid-column:1/-1}}
'''
JS=r'''
const DATA=window.__DATA__; const GLOSS=window.__GLOSS__;
const fmtTime=s=>new Date(s).toLocaleString([], {month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit'});
const ago=s=>{const m=Math.round((Date.now()-new Date(s))/60000);return m<60?`${m}m`:m<1440?`${Math.round(m/60)}h`:`${Math.round(m/1440)}d`};
function tooltipTerms(s){return s.replace(/frontier|ready node|residue|Milestone 1|terminal audit|Queue C|Queue E/g,m=>`<span class="gloss" data-g="${m}">${m}</span>`)}
function spark(el, arr){const w=500,h=90,m=8; const svg=d3.select(el).append('svg').attr('viewBox',`0 0 ${w} ${h}`); const x=d3.scaleTime().domain(d3.extent(arr,d=>new Date(d.t))).range([m,w-m]); const y=d3.scaleLinear().domain([0,d3.max(arr,d=>Math.max(d.n,d.ewma))||1]).nice().range([h-m,m]); svg.selectAll('line.bar').data(arr).join('line').attr('x1',d=>x(new Date(d.t))).attr('x2',d=>x(new Date(d.t))).attr('y1',y(0)).attr('y2',d=>y(d.n)).attr('stroke','#b9c1c7').attr('stroke-width',4); svg.append('path').datum(arr).attr('fill','none').attr('stroke','currentColor').attr('stroke-width',1.7).attr('d',d3.line().x(d=>x(new Date(d.t))).y(d=>y(d.ewma)).curve(d3.curveMonotoneX));}
function graph(el, nodes){const visible=nodes; const ids=new Set(visible.map(d=>d.id)); const links=[]; visible.forEach(n=>n.needs.forEach(a=>{if(ids.has(a))links.push({source:a,target:n.id})})); const w=800,h=230; const svg=d3.select(el).append('svg').attr('viewBox',`0 0 ${w} ${h}`); const g=svg.append('g'); svg.call(d3.zoom().scaleExtent([.3,5]).on('zoom',e=>g.attr('transform',e.transform))); const layer=new Map(); let changed=true; visible.forEach(n=>layer.set(n.id,0)); for(let z=0;z<visible.length&&changed;z++){changed=false;links.forEach(l=>{let v=Math.max(layer.get(l.target),layer.get(l.source)+1); if(v!==layer.get(l.target)){layer.set(l.target,v);changed=true}})} const groups=d3.group(visible,n=>layer.get(n.id)); for(const [k,ns] of groups){ns.forEach((n,i)=>{n.x=70+k*155;n.y=25+i*(Math.max(26,190/Math.max(1,ns.length)));})} g.selectAll('line').data(links).join('line').attr('x1',d=>visible.find(n=>n.id===d.source).x).attr('y1',d=>visible.find(n=>n.id===d.source).y).attr('x2',d=>visible.find(n=>n.id===d.target).x).attr('y2',d=>visible.find(n=>n.id===d.target).y).attr('stroke','#c7ced3'); const ng=g.selectAll('g.n').data(visible).join('g').attr('class','n').attr('transform',d=>`translate(${d.x},${d.y})`).on('pointermove',(e,d)=>showTip(e,`<b>${d.id}</b><br>${tooltipTerms(d.text)}${d.acceptance?`<br><br><b>Acceptance:</b> ${d.acceptance}`:''}`)).on('pointerleave',hideTip); ng.append('circle').attr('r',d=>d.ready?7:5).attr('fill',d=>d.closed?'#b8c0c5':d.ready?'#1d6f42':'#d28a22'); ng.append('text').attr('x',9).attr('y',3).attr('font-size',9).text(d=>d.id);}
const tip=d3.select('#tip'); function showTip(e,s){tip.html(s).style('opacity',1).style('left',(e.clientX+12)+'px').style('top',(e.clientY+12)+'px')} function hideTip(){tip.style('opacity',0)}
document.addEventListener('pointerover',e=>{let g=e.target.closest('[data-g]');if(g)showTip(e,GLOSS[g.dataset.g])});document.addEventListener('pointerout',e=>{if(e.target.closest('[data-g]'))hideTip()});
for(const r of DATA.repos){const host=document.querySelector(`#repo-${CSS.escape(r.name)}`);spark(host.querySelector('.commit-chart'),r.hourly);graph(host.querySelector('.dagbox'),r.dag);}
'''

def render(data, out: Path):
    cards=[]
    for r in data['repos']:
        p=r['progress']; metric=''
        if r['name']=='new-qual-site':
            proj=r.get('history',{}).get('projection')
            eta=f" · robust net ETA {proj['eta_hours']:.0f}h" if proj and proj.get('eta_hours') and proj['eta_hours']<10000 else ''
            metric=f"<div class=metric>{p['unsolved']:,}</div><div class=tiny>unsolved cards · Queue E {p['queue_e_executable']} executable / {p['queue_e_blocked']} blocked{eta}</div>"
        elif r['name']=='lean-categories':
            fc=p['sources'].get('FC06',{}); metric=f"<div class=metric>{fc.get('search',0)}</div><div class=tiny>FC06 first-pass search rows remaining · {fc.get('residue-search',0)} later <span class='gloss' data-g='residue'>residue</span> rows</div>"
        else:
            metric=f"<div class=metric>{r['dag_summary']['open']}</div><div class=tiny>open DAG nodes · {r['dag_summary']['ready']} <span class='gloss' data-g='ready node'>ready</span></div>"
        commits_html=''.join(f"<div class=row><span class=time>{age_label(c['time'])}</span><span class=subj title='{html.escape(c['subject'])}'>{html.escape(c['subject'])}</span><span>±{c['insertions']}/{c['deletions']} · {c['files']}f</span></div>" for c in r['commits'][:12])
        files_html=''.join(f"<div class=row><span class=time>{age_label(f['time'])}</span><span class=subj title='{html.escape(f['path'])}'>{html.escape(f['path'])}</span><span>{f['bytes']//1024}k</span></div>" for f in r['files'][:12])
        cards.append(f'''<section class="repo" id="repo-{r['name']}"><header class=rh><div><b>{r['name']}</b> <span class=pill>{r['head']}</span></div><span class="state {r['classification']}">{r['classification']}</span><span class=tiny>{r['dirty']['count']} dirty · {len(r['processes'])} repo processes</span></header><div class=bands><div class=panel><div class=title>Repository progress</div>{metric}<div class=tiny muted>{mark_terms(p.get('definition',''))}</div></div><div class=panel><div class=title>Banked commits · 48 hours</div><div class="chart commit-chart"></div><div class=tiny muted>bars = commits/hour · line = EWMA; activity, not correctness</div></div></div><div class=title style="padding:0 10px">Dependency/work DAG · drag/pinch/scroll to navigate</div><div class=dagbox></div><div class=bands><div><div class=title>Recent commits</div><div class=tail>{commits_html}</div></div><div><div class=title>Recent file writes (mtime)</div><div class=tail>{files_html}</div></div></div></section>''')
    payload=json.dumps(data,separators=(',',':')).replace('</','<\\/')
    glossary=json.dumps(GLOSSARY,separators=(',',':')).replace('</','<\\/')
    text=f'''<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1,maximum-scale=5"><title>Workstream observatory</title><style>{CSS}</style><script src="https://cdn.jsdelivr.net/npm/d3@7"></script></head><body><div class=wrap><div class=top><div><h1 style="font-size:22px;margin:0">Workstream observatory</h1><div class=muted>Recent banked work, live writes, execution and dependency state. None of these surfaces by itself certifies mathematical correctness.</div></div><div class=tiny>refreshed {html.escape(data['generated_at'])}</div></div><div class=grid>{''.join(cards)}</div><div class=foot>Definitions: hover/tap dotted terms. Commit and mtime distributions are observability signals; repository TODO/frontier/queue files and direct execution remain authoritative.</div></div><div id=tip class=tip></div><script>window.__DATA__={payload};window.__GLOSS__={glossary};</script><script>{JS}</script></body></html>'''
    out.parent.mkdir(parents=True,exist_ok=True); out.write_text(text)

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--output',default=str(ROOT/'steward-dashboard/index.html')); ap.add_argument('--classification',action='append',default=[])
    a=ap.parse_args(); cls={x.split('=',1)[0]:x.split('=',1)[1] for x in a.classification if '=' in x}
    data={'generated_at':dt.datetime.now().astimezone().isoformat(),'repos':[]}
    for n,r in REPOS.items(): data['repos'].append(repo_payload(n,r,cls.get(n,'unknown')))
    render(data,Path(a.output)); print(a.output)
if __name__=='__main__': main()
