import React, { useEffect, useRef, useState } from 'react';
import { createRemoteWebClient } from './client.mjs';

const AUTH_FAILURES = new Set(['AUTH_REQUIRED', 'AUTH_FAILED', 'ACCESS_DENIED', 'STALE_SESSION']);
function errorText(error) {
  if (error?.code === 'RESPONSE_LIMIT') return 'The response is too large. Previously received data is stale.';
  if (error?.code === 'INVALID_RESPONSE') return 'The server response could not be verified. Previously received data is stale.';
  if (error?.code === 'INVALID_REQUEST') return 'Check the invitation ID, secret and browser name.';
  if (AUTH_FAILURES.has(error?.code)) return 'Browser approval is unavailable. Check the working computer.';
  if (error?.code === 'PENDING_APPROVAL') return 'Local approval is still pending.';
  if (error?.code === 'NOT_FOUND') return 'This item is unavailable or is no longer shared.';
  if (error?.code === 'BUSY') return 'Wait for the current request to finish.';
  return 'The connection is unavailable. Previously received data is stale.';
}
function Freshness({ at, stale }) {
  return <p className={stale && at ? 'freshness stale' : 'freshness'}>{at ? <>Last successful update: <time dateTime={at}>{new Date(at).toLocaleString()}</time>{stale ? ' · stale' : ''}</> : 'Not loaded.'}</p>;
}
export default function RemoteReadApp() {
  const [client] = useState(() => createRemoteWebClient());
  const [invitationId, setInvitationId] = useState(''), [secret, setSecret] = useState(''), [clientName, setClientName] = useState('');
  const [session, setSession] = useState(null), [pending, setPending] = useState(''), [error, setError] = useState(''), [disconnected, setDisconnected] = useState(false);
  const [logoutUnconfirmed, setLogoutUnconfirmed] = useState(false);
  const [downloadNotice,setDownloadNotice]=useState('');
  const [projects, setProjects] = useState([]), [reviews, setReviews] = useState([]), [detail, setDetail] = useState(null);
  const [timeline, setTimeline] = useState(null);
  const [projectId, setProjectId] = useState(''), [reviewId, setReviewId] = useState('');
  const [updated, setUpdated] = useState({ projects: null, reviews: null, detail: null });
  const [stale, setStale] = useState({ projects: true, reviews: true, detail: true });
  const sequence = useRef(0), alive = useRef(true), inFlight = useRef('');
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; client.cancel(); }; }, [client]);
  const clearData = () => {
    setProjects([]); setReviews([]); setDetail(null); setTimeline(null); setProjectId(''); setReviewId('');
    setUpdated({ projects: null, reviews: null, detail: null }); setStale({ projects: true, reviews: true, detail: true });
    setDownloadNotice('');
  };
  const action = async (name, invoke, accept) => {
    if (inFlight.current) return;
    const original = ++sequence.current; inFlight.current = name; setPending(name); setError('');setDownloadNotice('');
    try {
      const value = await invoke();
      if (!alive.current || original !== sequence.current) {if(name==='download')value.bytes.fill(0);return;}
      setDisconnected(false); setLogoutUnconfirmed(false); accept(value);
    } catch (cause) {
      if (!alive.current || original !== sequence.current) return;
      setError(errorText(cause)); setDisconnected(true); setStale({ projects: true, reviews: true, detail: true });
      if (AUTH_FAILURES.has(cause?.code)) { setSession(null); clearData(); }
    } finally {
      if (alive.current && original === sequence.current) { inFlight.current = ''; setPending(''); if (name === 'login') setSecret(''); }
    }
  };
  const acceptSession = value => { setSession(value); if (value.state !== 'approved') clearData(); };
  const login = event => { event.preventDefault(); action('login', () => client.login({ invitationId, secret, clientName }), acceptSession); };
  const check = () => action('status', () => client.status(), acceptSession);
  const loadProjects = () => action('projects', () => client.read('projects.list', {}), value => {
    setProjects(value.projects); setUpdated(current => ({ ...current, projects: new Date().toISOString() })); setStale(current => ({ ...current, projects: false }));
    if (!value.projects.some(row => row.id === projectId)) { setProjectId(''); setReviewId(''); setReviews([]); setDetail(null); setUpdated(current => ({ ...current, reviews: null, detail: null })); }
  });
  const loadReviews = () => action('reviews', () => client.read('reviews.list', { projectId }), value => {
    setReviews(value.reviews); setDetail(null); setTimeline(null); setUpdated(current => ({ ...current, reviews: new Date().toISOString(), detail: null })); setStale(current => ({ ...current, reviews: false, detail: true }));
    if (!value.reviews.some(row => row.id === reviewId)) setReviewId('');
  });
  const loadDetail = () => action('detail', async () => ({review: (await client.read('reviews.get', { projectId, reviewId })).review,
    timeline: await client.read('reviews.timeline', {projectId, reviewId})}), value => {
    setDetail(value.review); setTimeline(value.timeline); setUpdated(current => ({ ...current, detail: new Date().toISOString() })); setStale(current => ({ ...current, detail: false }));
  });
  const downloadAttachment=row=>{
    const expected=Object.fromEntries(['id','reviewId','activityId','name','mimeType','size','sha256','createdAt'].map(key=>[key,row[key]]));
    action('download',()=>client.downloadAttachment({projectId,reviewId,attachmentId:expected.id}),value=>{
      let url,anchor;
      try{
        if(Object.keys(expected).some(key=>expected[key]!==value.attachment[key]))throw Object.assign(new Error('The attachment changed.'),{code:'INVALID_RESPONSE'});
        // Always download as inert binary; a shared HTML/SVG file is never opened
        // as active content inside this trusted browser origin.
        url=URL.createObjectURL(new Blob([value.bytes],{type:'application/octet-stream'}));
        anchor=document.createElement('a');anchor.href=url;anchor.download=value.attachment.name;anchor.rel='noopener';
        document.body.append(anchor);anchor.click();setDownloadNotice(`Verified download: ${value.attachment.name}`);
      }finally{
        anchor?.remove();value.bytes.fill(0);
        if(url)setTimeout(()=>URL.revokeObjectURL(url),1000);
      }
    });
  };
  const refresh = useRef(null);
  refresh.current = () => {
    if (session?.state !== 'approved' || inFlight.current || document.hidden) return;
    action('refresh', async () => {
      const nextProjects = await client.read('projects.list', {});
      if (!projectId || !nextProjects.projects.some(row=>row.id===projectId)) return {projects:nextProjects.projects};
      const nextReviews = await client.read('reviews.list', {projectId});
      if (!reviewId || !nextReviews.reviews.some(row=>row.id===reviewId)) return {projects:nextProjects.projects,reviews:nextReviews.reviews};
      const nextDetail = await client.read('reviews.get', {projectId,reviewId});
      return {projects:nextProjects.projects,reviews:nextReviews.reviews,detail:nextDetail.review,
        timeline:await client.read('reviews.timeline',{projectId,reviewId})};
    }, value => {
      const at=new Date().toISOString(); setProjects(value.projects);
      setUpdated(current=>({...current,projects:at,...(value.reviews?{reviews:at}:{}),...(value.detail?{detail:at}:{})}));
      setStale({projects:false,reviews:!value.reviews,detail:!value.detail});
      if(value.reviews)setReviews(value.reviews);else{setProjectId('');setReviewId('');setReviews([]);}
      if(value.detail){setDetail(value.detail);setTimeline(value.timeline);}else{setDetail(null);setTimeline(null);setReviewId('');}
    });
  };
  useEffect(()=>{
    if(session?.state!=='approved')return;
    refresh.current?.();
    const timer=setInterval(()=>refresh.current?.(),15000);
    return()=>clearInterval(timer);
  },[session?.state]);
  const logout = async () => {
    if (inFlight.current === 'logout') return;
    const original = ++sequence.current; inFlight.current = 'logout'; setPending('logout'); setSession(null); setSecret(''); clearData(); setError('');
    try {
      await client.logout();
      if (alive.current && original === sequence.current) { setDisconnected(false); setLogoutUnconfirmed(false); }
    } catch {
      if (alive.current && original === sequence.current) { setDisconnected(true); setLogoutUnconfirmed(true); setError('The local view was cleared, but server logout was not confirmed.'); }
    } finally { if (alive.current && original === sequence.current) { inFlight.current = ''; setPending(''); } }
  };
  const approved = session?.state === 'approved', busy = Boolean(pending);
  const stateLabel = logoutUnconfirmed ? 'Logout not confirmed' : disconnected ? 'Disconnected' : approved ? 'Approved for read-only access' : session?.state === 'pending' ? 'Waiting for local approval' : 'Not connected';
  return <div className="remote-app">
    <header className="app-heading"><div><p className="eyebrow">ReviewOps</p><h1>Web access</h1><p>Read projects shared by the working computer.</p></div><div className="session-state" role="status"><strong>{stateLabel}</strong>{session && <small>Session expires <time dateTime={session.expiresAt}>{new Date(session.expiresAt).toLocaleString()}</time></small>}</div></header>
    {error && <p className="error" role="alert">{error}</p>}
    {!approved && <section className="panel" aria-labelledby="sign-in-title"><h2 id="sign-in-title">Browser approval</h2><p>Use the invitation shown on the working computer. Open only its approved HTTPS address.</p>
      <form onSubmit={login} autoComplete="off"><div className="form-grid"><label>Invitation ID<input value={invitationId} onChange={event => setInvitationId(event.target.value)} maxLength={36} required disabled={busy} spellCheck="false" autoCapitalize="none" /></label><label>One-use secret<input type="password" value={secret} onChange={event => setSecret(event.target.value)} maxLength={43} required disabled={busy} autoComplete="one-time-code" /></label><label>Browser name<input value={clientName} onChange={event => setClientName(event.target.value)} maxLength={80} required disabled={busy} /></label></div><div className="actions"><button type="submit" disabled={busy}>Request approval</button><button type="button" onClick={check} disabled={busy}>Check approval</button></div></form>
      {session?.state === 'pending' && <p role="status">Approve this browser and select shared projects on the working computer, then check approval here.</p>}
    </section>}
    <div className="actions session-actions"><button type="button" onClick={check} disabled={busy}>Check connection</button><button type="button" onClick={logout} disabled={pending === 'logout'}>{pending === 'logout' ? 'Logging out…' : 'Log out and clear this view'}</button>{busy && <span role="status">Working…</span>}</div>
    {approved && <main>
      <section className="panel" aria-labelledby="projects-title"><div className="section-heading"><h2 id="projects-title">Projects</h2><button type="button" onClick={loadProjects} disabled={busy}>Refresh projects</button></div><Freshness at={updated.projects} stale={stale.projects} /><label>Shared project<select value={projectId} disabled={busy || !projects.length} onChange={event => { setProjectId(event.target.value); setReviewId(''); setReviews([]); setDetail(null); setTimeline(null); setUpdated(current => ({ ...current, reviews: null, detail: null })); setStale(current => ({ ...current, reviews: true, detail: true })); }}><option value="">Select a project</option>{projects.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>{updated.projects && !projects.length && <p>No projects are currently shared.</p>}{projects.find(row => row.id === projectId)?.description && <p className="user-text">{projects.find(row => row.id === projectId).description}</p>}</section>
      <section className="panel" aria-labelledby="reviews-title"><div className="section-heading"><h2 id="reviews-title">Reviews</h2><button type="button" onClick={loadReviews} disabled={busy || !projectId}>Refresh reviews</button></div><Freshness at={updated.reviews} stale={stale.reviews} /><label>Review<select value={reviewId} disabled={busy || !reviews.length} onChange={event => { setReviewId(event.target.value); setDetail(null); setTimeline(null); setUpdated(current => ({ ...current, detail: null })); setStale(current => ({ ...current, detail: true })); }}><option value="">Select a review</option>{reviews.map(row => <option key={row.id} value={row.id}>#{row.number} · {row.title}</option>)}</select></label><button type="button" onClick={loadDetail} disabled={busy || !projectId || !reviewId}>Open or refresh review</button>{updated.reviews && !reviews.length && <p>This project has no reviews.</p>}</section>
      <section className="panel" aria-labelledby="detail-title"><h2 id="detail-title">Review detail</h2><Freshness at={updated.detail} stale={stale.detail} />{detail ? <article><h3>#{detail.number} · {detail.title}</h3><dl><dt>Status</dt><dd>{detail.status}</dd><dt>Priority</dt><dd>{detail.priority}</dd><dt>Category</dt><dd>{detail.category}</dd><dt>Last edited</dt><dd><time dateTime={detail.updatedAt}>{new Date(detail.updatedAt).toLocaleString()}</time></dd></dl><pre className="user-text review-body">{detail.body}</pre></article> : <p>Select a shared review to read it.</p>}</section>
      {timeline&&<>
        <section className="panel"><h2>Comments and history</h2><Freshness at={updated.detail} stale={stale.detail}/>{timeline.activities.length?timeline.activities.map(row=><article key={row.id}><h3>{row.role} · {row.type}</h3><time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString()}</time>{row.toStatus&&<p>{row.fromStatus} → {row.toStatus}</p>}<pre className="user-text">{row.body}</pre></article>):<p>No shared history.</p>}</section>
        <section className="panel"><h2>Attachments</h2><p>Downloads are verified before saving. Maximum file size: 10 MiB.</p>{downloadNotice&&<p role="status">{downloadNotice}</p>}{timeline.attachments.length?<ul>{timeline.attachments.map(row=><li key={row.id}>{row.name} · {row.size.toLocaleString()} bytes <button type="button" aria-label={`Download ${row.name}`} disabled={busy||stale.detail||disconnected||row.size>10*1024*1024} onClick={()=>downloadAttachment(row)}>Download</button>{row.size>10*1024*1024&&' · Exceeds the download limit.'}</li>)}</ul>:<p>No shared attachments.</p>}</section>
        <section className="panel"><h2>Agent activity and results</h2><Freshness at={updated.detail} stale={stale.detail}/>{timeline.agentRuns.length?timeline.agentRuns.map(row=><article key={row.id}><h3>{row.status}</h3><p>Started <time dateTime={row.startedAt}>{new Date(row.startedAt).toLocaleString()}</time>{row.finishedAt&&<> · Finished <time dateTime={row.finishedAt}>{new Date(row.finishedAt).toLocaleString()}</time></>}</p><pre className="user-text">{row.response}</pre></article>):<p>No agent activity.</p>}</section>
      </>}
    </main>}
    <footer>Read-only browser access. Changes and agent controls are not available here.</footer>
  </div>;
}
