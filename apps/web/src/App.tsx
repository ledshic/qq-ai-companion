import { useEffect, useMemo, useRef, useState } from 'react';
import { createServiceClient } from '@companion/client/service';
import { APIError, type Conversation, type Message, type Principal, type Run, type ServiceEvent, type ServiceStatus } from '@companion/contracts/service';
import { ConnectionLab } from './ConnectionLab';
import { MemorySources } from './MemorySources';
import './workspace.css';
import xiaojingyuAvatar from './assets/xiaojingyu.gif';
const labels: Record<string, string> = { queued: '排队中', running: '正在思考', completed: '已完成', failed: '执行失败', cancelled: '已取消', interrupted: '已中断', model_not_configured: '模型尚未配置，请在服务端启用模型后重试。', unauthorized: '会话已失效，请重新连接。', runtime_paused: '服务已暂停接收新消息。', origin_not_allowed: '当前页面来源未获允许，请配置 AGENT_WEB_ORIGINS。' };
const explain = (e: unknown) => e instanceof APIError ? labels[e.code] ?? e.code : e instanceof Error ? e.message : '请求失败，请重试';
const time = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
export function App() { return new URLSearchParams(location.search).has('lab') ? <ConnectionLab /> : <Workspace />; }
function Brand() { return <div className="wordmark"><span className="brand-mark" aria-hidden="true">C</span><span>Ciri</span></div>; }
function Workspace() {
  const [address, setAddress] = useState(localStorage.getItem('companion.address') ?? 'http://127.0.0.1:4320');
  const [endpoint, setEndpoint] = useState(() => { try { return new URL(address).origin; } catch { return 'http://127.0.0.1:4320'; } });
  const client = useMemo(() => createServiceClient(endpoint), [endpoint]);
  const [token, setToken] = useState('');
  const [me, setMe] = useState<Principal>();
  const [status, setStatus] = useState<ServiceStatus>();
  const [page, setPage] = useState<'chat' | 'dashboard'>('chat');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState('');
  const [showSources, setShowSources] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [events, setEvents] = useState<ServiceEvent[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [pairings, setPairings] = useState<{ id: string; name: string; expiresAt: string }[]>([]);
  const [devices, setDevices] = useState<{ id: string; name: string; admin: boolean; revoked: boolean }[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(false);
  const retry = useRef<{ id: string; content: string; conversation: string } | undefined>(undefined);
  const bottom = useRef<HTMLDivElement>(null);
  const currentConversation = conversations.find(c => c.id === selected && c.ownerId === me?.ownerId);
  const currentRun = runs.find(r => r.conversationId === selected && ['queued', 'running'].includes(r.state));
  async function action(work: () => Promise<void>) { setError(''); setBusy(true); try { await work(); } catch (e) { setError(explain(e)); } finally { setBusy(false); } }
  async function snapshot() {
    const [identity, health] = await Promise.all([client.me(), client.status()]);
    setMe(identity); setStatus(health);
    const all: Conversation[] = []; let after = '';
    for (;;) { const p = await client.conversations(after); all.push(...p.conversations); if (!p.conversations.length) break; after = p.nextCursor; }
    setConversations(all); setSelected(s => s && all.some(c => c.id === s) ? s : all[0]?.id ?? '');
    if (identity.admin) { const [p, d] = await Promise.all([client.pairings(), client.devices()]); setPairings(p.pairings); setDevices(d.devices); }
  }
  async function history(conversation: string) {
    const all: Message[] = []; let after = 0;
    for (;;) { const p = await client.messages(conversation, after); all.push(...p.messages); if (!p.messages.length) break; after = p.nextCursor; }
    return all;
  }
  useEffect(() => { let alive = true; void client.me().then(identity => { if (alive) { setMe(identity); void action(snapshot); } }).catch(() => {}); return () => { alive = false; }; }, [client]);
  useEffect(() => {
    setMessages([]); if (!me || !selected) return;
    let alive = true;
    const update = () => void history(selected).then(items => { if (alive) setMessages(items); }).catch(e => { if (alive) setError(explain(e)); });
    update(); const timer = setInterval(update, 2500);
    return () => { alive = false; clearInterval(timer); };
  }, [client, me, selected]);
  useEffect(() => {
    if (!me) return;
    let alive = true, cursor = 0, pending = false;
    const poll = async () => { if (pending) return; pending = true; try {
      const [p, health] = await Promise.all([client.events(cursor), client.status()]);
      const ids = [...new Set(p.events.map(e => e.runId))];
      const updates = await Promise.all(ids.map(id => client.run(id)));
      if (!alive) return;
      cursor = p.nextCursor; setStatus(health); setOnline(true);
      setEvents(old => [...p.events.reverse(), ...old].slice(0, 80));
      setRuns(old => [...updates, ...old.filter(r => !ids.includes(r.id))]);
    } catch (e) { if (!alive) return; setOnline(false); if (e instanceof APIError && e.code === 'event_resync_required') { cursor = 0; setEvents([]); } else if (e instanceof APIError && e.status === 401) { setMe(undefined); setError(explain(e)); } } finally { pending = false; } };
    void poll(); const timer = setInterval(() => void poll(), 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [client, me]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages.length, selected]);
  async function logout() { await client.logout(); setMe(undefined); setMessages([]); setRuns([]); setEvents([]); }
  async function create() { const c = await client.createConversation('新的对话'); setConversations(old => [...old, c]); setSelected(c.id); setPage('chat'); }
  async function send() {
    const content = draft.trim(); if (!content || currentRun || busy || !status?.accepting) return;
    await action(async () => {
      let conversation = selected;
      if (!conversation) { const c = await client.createConversation(content.slice(0, 40)); conversation = c.id; setConversations(old => [...old, c]); setSelected(c.id); }
      const attempt = retry.current?.content === content && retry.current.conversation === conversation ? retry.current : { id: crypto.randomUUID(), content, conversation };
      retry.current = attempt;
      const accepted = await client.submit(conversation, attempt.id, content);
      const run = await client.run(accepted.runId); setRuns(old => [run, ...old.filter(r => r.id !== run.id)]);
      setMessages(await history(conversation)); retry.current = undefined; setDraft('');
    });
  }
  if (!me) return <div className="workspace login"><div className="login-card"><Brand /><p className="kicker">YOUR PERSONAL AGENT</p><h1>让对话继续。</h1><p className="muted">连接你的常驻 Agent，开始对话或管理服务。</p><form onSubmit={e => { e.preventDefault(); void action(async () => { const c = createServiceClient(address, { token }); await c.login(); setToken(''); localStorage.setItem('companion.address', address); if (endpoint === address) await snapshot(); else setEndpoint(address); }); }}><label htmlFor="service">服务地址</label><input id="service" type="url" required value={address} onChange={e => setAddress(e.target.value)} /><label htmlFor="credential">设备凭据</label><input id="credential" type="password" autoComplete="off" required value={token} onChange={e => setToken(e.target.value)} /><button className="primary" disabled={busy}> {busy ? '连接中…' : '连接工作台 →'}</button></form><p className="muted small">使用已有设备或本机拥有者凭据。凭据仅用于建立 HttpOnly 浏览器会话，不保存在页面中。</p>{error && <div role="alert" className="notice">{error}</div>}</div></div>;
  return <div className="workspace"><aside className="rail"><Brand /><p className="kicker">WORKSPACE</p><nav><button className={page === 'chat' ? 'active' : ''} onClick={() => setPage('chat')}>◌ 对话空间</button><button className={page === 'dashboard' ? 'active' : ''} onClick={() => setPage('dashboard')}>▦ 服务概览</button></nav><div className="rail-heading">我的对话 <button aria-label="新建对话" disabled={busy} onClick={() => void action(create)}>＋</button></div><div className="conversation-list">{conversations.map(c => <button key={c.id} className={selected === c.id && page === 'chat' ? 'active' : ''} onClick={() => { setSelected(c.id); setPage('chat'); }}>{c.title}</button>)}{!conversations.length && <p className="muted small">还没有对话，开始聊聊吧。</p>}</div><div className="identity"><span className={'dot ' + (online ? 'green' : '')} />{online ? '服务已连接' : '正在重连'}<small>{me.admin ? '拥有者' : '普通设备'} · {me.deviceId.slice(0, 8)}</small><button onClick={() => void action(logout)}>退出连接 ↗</button></div></aside><section className="work-main"><div className="topbar"><span>{page === 'chat' ? '工作台 / 对话空间' : '工作台 / 服务概览'}</span><div className="topbar-actions"><span className="pill">{online ? (status?.accepting ? '接收请求中' : '已暂停接收') : '正在重连'}</span><button className="mobile-logout" disabled={busy} onClick={() => void action(logout)}>退出连接</button></div></div>{error && <div role="alert" className="notice">{error}<button aria-label="关闭提示" onClick={() => setError('')}>×</button></div>}
  {page === 'chat' ? <><div className="chat-heading"><div><p className="kicker">A LITTLE SPACE FOR YOUR THOUGHTS</p><h2>{conversations.find(c => c.id === selected)?.title ?? '新的开始'}</h2></div><div className="chat-heading-actions"><button className="secondary" disabled={!currentConversation} aria-expanded={showSources} aria-controls="memory-sources" onClick={() => setShowSources(value => !value)}>来源授权</button><button className="secondary" disabled={busy} onClick={() => void action(create)}>＋ 新对话</button></div></div>{showSources && currentConversation && <MemorySources key={JSON.stringify([endpoint, me.ownerId, me.deviceId, selected])} client={client} conversation={currentConversation} admin={me.admin} />}<select className="mobile-conversations" aria-label="选择对话" value={selected} onChange={e => setSelected(e.target.value)}><option value="" disabled>选择对话</option>{conversations.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select><div className="transcript" role="log" aria-label="对话消息">{!messages.length && <div className="welcome"><div className="orb" aria-hidden="true"><img src={xiaojingyuAvatar} alt="" /></div><h1>今天，想聊些什么？</h1><p className="muted">一个想法，一个问题，或是日常的小事。</p><div className="suggestions">{['帮我整理今天的计划', '一起梳理一个新想法', '介绍一下你能做什么'].map(s => <button key={s} onClick={() => setDraft(s)}>{s} ↗</button>)}</div></div>}{messages.map(m => <article key={m.id} className={'message ' + m.role}><div className="avatar">{m.role === 'user' ? '我' : <img src={xiaojingyuAvatar} alt="" />}</div><div><div className="message-meta">{m.role === 'user' ? '你' : '小鲸鱼'} <time>{time(m.createdAt)}</time></div>{m.role === 'assistant' && m.reasoning && <details className="reasoning"><summary>思考过程</summary><div>{m.reasoning}</div></details>}<div className="message-content">{m.content}</div></div></article>)}{runs.filter(r => r.conversationId === selected && r.state !== 'completed').slice(0, 1).map(r => <div className="run-note" role="status" key={r.id}>{labels[r.state]}{r.error && ` · ${labels[r.error] ?? r.error}`}</div>)}<div ref={bottom} /></div><div className="composer-area"><form className="composer" onSubmit={e => { e.preventDefault(); void send(); }}><textarea aria-label="发送消息" placeholder="写下你的想法…" maxLength={8000} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} /><div className="composer-bottom"><span>Enter 发送 · Shift + Enter 换行</span>{currentRun ? <button type="button" className="primary" disabled={busy} onClick={() => void action(async () => { const r = await client.cancel(currentRun.id); setRuns(old => old.map(x => x.id === r.id ? r : x)); })}>停止生成 ■</button> : <button className="primary" disabled={busy || !draft.trim() || !status?.accepting}>发送 ↑</button>}</div></form><p className="small muted centered">独立工作台会话 · 关闭页面后，已提交的任务仍会继续运行</p></div></> : <div className="dashboard"><p className="kicker">AGENT OVERVIEW</p><div className="dashboard-title"><div><h1>服务概览</h1><p className="muted">查看运行状态，管理你的连接。</p></div><button className="secondary" disabled={busy} onClick={() => void action(snapshot)}>刷新 ↻</button></div><div className="metrics"><div className="panel"><span>运行时</span><strong>{status?.accepting ? '运行中' : '已暂停'}</strong><small>新请求接收状态</small></div><div className="panel"><span>语言模型</span><strong>{status?.model === 'configured' ? '已配置' : '未配置'}</strong><small>配置状态，不代表上游可用性</small></div><div className="panel"><span>QQ 通道</span><strong>{status?.qq === 'connected' ? '已连接' : status?.qq === 'disabled' ? '未启用' : '已断开'}</strong><small>适配器连接状态</small></div><div className="panel"><span>工作台会话</span><strong>{conversations.length.toString().padStart(2, '0')}</strong><small>当前身份可见会话</small></div></div><div className="dashboard-grid"><section className="panel"><div className="panel-heading"><h2>最近活动</h2><span className="pill">{online ? '实时更新' : '连接恢复中'}</span></div>{!events.length && <p className="muted">暂无活动，发送一条消息开始。</p>}{events.slice(0, 15).map(e => <div className="activity" key={e.eventId}><span className="activity-icon">↗</span><div><b>{e.type}</b><small>{e.conversationId.slice(0, 12)}</small></div><time>{time(e.time)}</time></div>)}</section><div><section className="panel"><h2>运行控制</h2><p className="muted small">暂停后停止接受新请求，已运行任务仍会继续。</p>{me.admin ? <button className="secondary" disabled={busy} onClick={() => void action(async () => { await (status?.accepting ? client.pause() : client.resume()); setStatus(await client.status()); })}>{status?.accepting ? '暂停接收请求' : '恢复接收请求'}</button> : <p className="muted">需要拥有者权限管理运行时与设备。</p>}</section>{me.admin && <><section className="panel"><h2>待批准设备</h2>{!pairings.length && <p className="muted small">没有待处理的配对请求</p>}{pairings.map(p => <div className="device" key={p.id}><div>{p.name}<small>有效至 {time(p.expiresAt)}</small></div><button className="secondary" disabled={busy} onClick={() => void action(async () => { await client.approvePairing(p.id); await snapshot(); })}>批准</button></div>)}</section><section className="panel"><h2>已连接设备</h2>{devices.map(d => <div className="device" key={d.id}><div>{d.name}<small>{d.revoked ? '已撤销' : d.admin ? '拥有者' : '已授权'}</small></div>{!d.admin && !d.revoked && <button className="secondary" disabled={busy} onClick={() => { if (window.confirm(`撤销设备「${d.name}」的访问权限？`)) void action(async () => { await client.revokeDevice(d.id); await snapshot(); }); }}>撤销</button>}</div>)}</section></>}</div></div></div>}</section></div>;
}
