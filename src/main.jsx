import { newId } from './id';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import QRCode from 'qrcode';
import { ArrowUpRight, ArrowRight, ArrowLeft, Upload, Download, FileText, X, Copy, Check, Send, Smartphone, Monitor, ShieldCheck, Zap, Link, Plus } from 'lucide-react';
import { connect } from './connection';
import './style.css';
import InfoDialog from './InfoDialog';

const bytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
function App() {
  const [page, setPage] = useState(null);
  const [room, setRoom] = useState(null), [paired, setPaired] = useState(false), [online, setOnline] = useState(false);
  const [code, setCode] = useState(new URLSearchParams(location.hash.slice(1)).get('room') || '');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [sending, setSending] = useState(false);
  const [files, setFiles] = useState([]), [messages, setMessages] = useState([]), [text, setText] = useState('');
  const [qr, setQr] = useState(''), [mode, setMode] = useState('Server relay'), [copied, setCopied] = useState(false), [drag, setDrag] = useState(false), [now, setNow] = useState(Date.now());
  const connection = useRef(), input = useRef(), feed = useRef(), sendLock = useRef(false);
  const clear = () => { setRoom(null); setPaired(false); setFiles([]); setMessages([]); setQr(''); history.replaceState(null, '', location.pathname); };
  useEffect(() => {
    connection.current = connect({ online: setOnline, paired: () => setPaired(true), mode: setMode, error: setError,
      ended: reason => { clear(); setError(reason); }, message: message => setMessages(m => [...m.slice(-199), message]),
      file: file => setFiles(current => current.some(f => f.id === file.id) ? current.map(f => f.id === file.id ? { ...f, ...file } : f) : [...current, file]) });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(timer); connection.current.destroy(); };
  }, []);
  useEffect(() => { if (feed.current) feed.current.scrollTop = feed.current.scrollHeight; }, [messages]);
  const url = room ? `${location.origin}/#room=${room.code}` : '';
  useEffect(() => { if (url) QRCode.toDataURL(url, { width: 240, margin: 1, color: { dark: '#193e34', light: '#ffffff' } }).then(setQr).catch(() => setError('QR code unavailable. Use the room code.')); }, [url]);
  async function enter(join) {
    setBusy(true); setError('');
    try { const result = await connection.current.enter(join ? code : null); setNow(Date.now()); setRoom(result); history.replaceState(null, '', `/#room=${result.code}`); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function upload(list) {
    if (!paired || sendLock.current || !list?.length) return;
    sendLock.current = true; setSending(true); setError('');
    try { for (const file of Array.from(list)) await connection.current.sendFile(file); } catch (e) { setError(e.message); } finally { sendLock.current = false; setSending(false); if (input.current) input.current.value = ''; }
  }
  async function send(e) {
    e.preventDefault(); const value = text.trim(); if (!value) return; setText('');
    try { await connection.current.chat(value); setMessages(m => [...m.slice(-199), { id: newId(), mine: true, text: value }]); } catch (e) { setError(e.message); setText(value); }
  }
  async function copy() { try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setError('Copy this room link: ' + url); } }
  return <div className="shell">
    <header><a className="brand" href="/" onClick={e => { if (room) e.preventDefault(); }}><span className="logo"><Send size={27}/></span>Fly<span>QR</span></a><nav aria-label="Main navigation"><button onClick={() => setPage('about')}>About</button><button onClick={() => setPage('contact')}>Contact</button><button className="support-button" onClick={() => setPage('support')}>Support me <span aria-hidden="true">♡</span></button></nav></header>
    {page && <InfoDialog key={page} page={page} close={() => setPage(null)}/>}
    {error && <div className="notice" role="alert"><span>{error}</span><button aria-label="Dismiss notification" onClick={() => setError('')}><X size={18}/></button></div>}
    {!room ? <main className="landing">
      <div className="intro"><div className="bubble bubble-one" aria-hidden="true">✦</div><div className="bubble bubble-two" aria-hidden="true">✳</div><div className="hello-pill">A little file magic. ✨</div><h1><span>Scan.</span> <span>Send.</span><br/><span>Done.</span><span className="hero-plane" aria-hidden="true"><Send/></span></h1><p>Your files. Your other device.<br/>No login. No extra steps.</p></div>
      <section className="start-panel"><div className="card-sticker" aria-hidden="true">↗</div><h2>Let’s connect!</h2><p>Start a room. Invite your other device.</p><button className="primary create" disabled={!online || busy} onClick={() => enter(false)}><Plus size={23}/>{busy ? 'One moment…' : 'Create a room'}<ArrowRight size={22}/></button><div className="divider"><span/>or<span/></div><form onSubmit={e => { e.preventDefault(); enter(true); }}><label htmlFor="code">Got a room code?</label><div className="join-row"><input id="code" placeholder="ABCD 2345" value={code} maxLength={12} onChange={e => setCode(e.target.value.toUpperCase())} autoComplete="off" spellCheck="false"/><button className="join-button" disabled={!online || busy || code.replace(/[\s-]/g, '').length !== 8}>Join <ArrowRight size={20}/></button></div></form>{!online && <p className="connection-status" role="status">Connecting to server…</p>}</section>
      <div className="how-it-works" aria-label="How it works"><div><span className="step-number">1</span><span>Create a room</span></div><span className="step-arrow" aria-hidden="true">↝</span><div><span className="step-number">2</span><span>Scan the QR</span></div><span className="step-arrow" aria-hidden="true">↝</span><div><span className="step-number">3</span><span>Send your stuff 🎉</span></div></div>
    </main> : <main className="room-page"><div className="room-heading"><div><h1>{paired ? 'You’re connected! 🎉' : 'Scan & hop in!'}</h1><p>{paired ? 'Send a file. Say hello. It’s that easy.' : 'Open your phone camera and scan this QR code.'}</p></div><button className="text-button" onClick={() => { connection.current.end(); clear(); }}><X size={16}/> End room</button></div><div className="room-grid"><aside className="room-card"><div className="room-status"><span className={`dot ${paired ? '' : 'waiting'}`}/>{paired ? '2 devices connected' : 'Waiting for a second device'}</div>{qr && <img className="qr" src={qr} alt="Scan to join this room"/>}<div className="code-label">ROOM CODE</div><strong className="room-code">{room.code.slice(0, 4)} {room.code.slice(4)}</strong><button className="copy-button" onClick={copy}>{copied ? <Check size={16}/> : <Copy size={16}/>} {copied ? 'Link copied' : 'Copy room link'}</button><div className="room-details"><span>Closes in {Math.max(0, Math.ceil((room.expires - now) / 60000))} min</span><span>{paired ? mode : 'Only share with your device'}</span></div></aside><section className="workspace"><div className="section-title"><h2>Files</h2><span>Up to 100 MB per file</span></div><input ref={input} type="file" multiple hidden onChange={e => upload(e.target.files)}/><button className={`drop-zone ${drag ? 'dragging' : ''}`} disabled={!paired || sending} onClick={() => input.current.click()} onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={e => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files); }}><span className="upload-icon"><Upload size={25}/></span><strong>{sending ? 'Sending your files…' : 'Drop your files here'}</strong><span>{paired ? 'or click to choose from your device' : 'File sharing starts when the other device joins'}</span></button><div className="file-list" aria-live="polite">{files.map(file => <div className="file-item" key={file.id}><FileText className="file-symbol" size={22}/><div className="file-info"><strong>{file.name}</strong><small>{bytes(file.size)} · {file.error || (file.done ? (file.mine ? 'Delivered' : 'Ready to download') : `${file.mine ? 'Sending' : 'Receiving'} ${file.progress}%`)}</small>{!file.done && !file.error && <progress max="100" value={file.progress}/>}</div>{file.url ? <a className="download" href={file.url} download={file.name} aria-label={`Download ${file.name}`}><Download size={19}/></a> : file.done ? <Check size={19} className="success"/> : null}</div>)}</div><section className="chat"><div className="section-title"><h2>Say something</h2><span>A note, a link, a little hello.</span></div><div ref={feed} className="messages" aria-live="polite">{messages.length ? messages.map(m => <div key={m.id} className={`message ${m.mine ? 'mine' : ''}`}><small>{m.mine ? 'You' : 'Other device'}</small><p>{m.text}</p></div>) : <div className="empty-chat">That link you need. A note to yourself.<br/>Send it over here.</div>}</div><form className="message-form" onSubmit={send}><input aria-label="Message" placeholder="Write a message…" maxLength={4000} value={text} onChange={e => setText(e.target.value)} disabled={!paired}/><button disabled={!paired || !text.trim()} aria-label="Send message"><Send size={18}/></button></form></section></section></div><p className="room-footnote"><ShieldCheck size={15}/> This room is temporary. Delete downloaded files from shared computers when you’re done.</p></main>}
    <footer><span>Made with <span className="heart">♥</span> by <a href="https://github.com/amenabidii" target="_blank" rel="noreferrer">Amen</a></span></footer>
  </div>;
}
createRoot(document.getElementById('root')).render(<App/>);
