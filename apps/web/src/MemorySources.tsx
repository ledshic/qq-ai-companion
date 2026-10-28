import { useEffect, useRef, useState } from 'react';
import type { createServiceClient } from '@companion/client/service';
import { APIError, type Conversation } from '@companion/contracts/service';

type Policy = { sourceConversationIds: string[]; revision: number };
type Client = ReturnType<typeof createServiceClient>;
function policyResponse(value: Policy): Policy {
  if (!value || !Array.isArray(value.sourceConversationIds) || value.sourceConversationIds.length > 8 ||
    value.sourceConversationIds.some(id => typeof id !== 'string' || !id.trim()) ||
    new Set(value.sourceConversationIds).size !== value.sourceConversationIds.length ||
    !Number.isSafeInteger(value.revision) || value.revision < 0) throw Error('invalid_policy');
  return value;
}
function explain(error: unknown) {
  if (error instanceof APIError) {
    if (error.code === 'memory_policy_conflict') return '授权已在其他设备上修改。请重新加载后再选择，当前改动未保存。';
    if (error.status === 403) return '当前设备没有修改权限，请使用拥有者管理设备。';
    if (error.status === 401) return '连接已失效，请重新连接工作台。';
    if (error.status === 404) return '会话或来源已不可用，请重新加载后再试。';
    if (error.code === 'invalid_memory_sources') return '来源列表无效，请检查是否超过 8 个或包含不可用会话。';
  }
  return '无法确认最新授权，请重新加载核对。未确认成功前不要将草稿视为已授权。';
}

// The parent keys this component by endpoint, identity and target conversation.
// Late responses are ignored after that scope is unmounted or a new load begins.
export function MemorySources({ client, conversation, admin }: {
  client: Client; conversation: Conversation; admin: boolean;
}) {
  const [policy, setPolicy] = useState<Policy>();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [draft, setDraft] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const eligible = conversations.filter(item => item.id !== conversation.id && item.ownerId === conversation.ownerId && item.kind === 'direct' && item.channelId === 'console');
  const options = [...eligible, ...(policy?.sourceConversationIds ?? []).filter(id => !eligible.some(item => item.id === id))
    .map(id => ({ id, title: '不可用的来源会话' }))];
  const title = (id: string) => eligible.find(item => item.id === id)?.title ?? '不可用的来源会话';
  const changed = !!policy && (draft.length !== policy.sourceConversationIds.length || draft.some(id => !policy.sourceConversationIds.includes(id)));

  async function sourceConversations(current: number) {
    const items: Conversation[] = [];
    let after = '';
    for (;;) {
      if (current !== generation.current) throw Error('stale_scope');
      const page = await client.conversations(after);
      if (current !== generation.current) throw Error('stale_scope');
      items.push(...page.conversations);
      if (!page.conversations.length) return items;
      if (!page.nextCursor || page.nextCursor <= after) throw Error('invalid_cursor');
      after = page.nextCursor;
    }
  }
  async function load() {
    const current = ++generation.current;
    setLoading(true); setError(''); setNotice('');
    try {
      const [response, items] = await Promise.all([client.memorySources(conversation.id), sourceConversations(current)]);
      const latest = policyResponse(response);
      if (current !== generation.current) return;
      setPolicy(latest); setDraft(latest.sourceConversationIds); setConversations(items); setUncertain(false);
    } catch (failure) {
      if (current === generation.current) { setError(explain(failure)); setUncertain(true); }
    } finally { if (current === generation.current) setLoading(false); }
  }
  useEffect(() => { void load(); return () => { generation.current++; }; }, [client, conversation.id]);

  async function save(ids: string[]) {
    if (!admin || !policy || loading || uncertain || pending.current) return;
    pending.current = true; setSaving(true); setError(''); setNotice('');
    const current = generation.current;
    try {
      const latest = policyResponse(await client.setMemorySources(conversation.id, ids, policy.revision));
      if (current !== generation.current) return;
      setPolicy(latest); setDraft(latest.sourceConversationIds);
      setNotice(latest.sourceConversationIds.length ? '来源授权已保存。' : '已撤销全部跨会话来源，仅保留当前会话。');
      panel.current?.scrollTo({ top: 0 });
    } catch (failure) {
      if (current === generation.current) { setError(explain(failure)); setUncertain(true); panel.current?.scrollTo({ top: 0 }); }
    } finally {
      pending.current = false;
      if (current === generation.current) setSaving(false);
    }
  }
  function toggle(id: string) {
    setNotice('');
    setDraft(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]);
  }
  return <section ref={panel} className="memory-sources" id="memory-sources" aria-label="来源授权管理" aria-busy={loading || saving}>
    <div className="memory-heading"><h3>来源授权</h3><button type="button" className="secondary" disabled={loading || saving} onClick={() => void load()}>重新加载</button></div>
    {error && <p role="alert" className="memory-error">{error}</p>}
    {notice && <p role="status" className="memory-success">{notice}</p>}
    <p className="small">当前会话：<strong>{conversation.title}</strong></p>
    <p className="muted small">允许当前会话引用所选会话的历史资料，授权不会反向生效。当前会话无需授权。是否召回仍取决于服务的记忆设置。</p>
    {loading && <p role="status">正在加载授权…</p>}
    {policy && <>
      <div className="memory-confirmed"><h4>{uncertain ? '上次确认的来源' : '已授权来源'}（{policy.sourceConversationIds.length}）</h4>
        {policy.sourceConversationIds.length ? <ul>{policy.sourceConversationIds.map(id => <li key={id}>{title(id)} <small>{id}</small></li>)}</ul>
          : <p className="small">仅当前会话，尚未授权其他来源。</p>}
      </div>
      {admin ? <>
        <fieldset disabled={loading || saving || uncertain}><legend>选择来源（{draft.length}/8）</legend>
          <p className="muted small">仅可选择你自己的其他直聊会话，最多 8 个。勾选后需保存才会生效。</p>
          {!options.length && <p className="small">暂无其他会话可授权。</p>}
          <div className="memory-options">{options.map(item => <label className="memory-option" key={item.id}>
            <input type="checkbox" checked={draft.includes(item.id)} disabled={!draft.includes(item.id) && draft.length >= 8} onChange={() => toggle(item.id)} />
            <span>{item.title}<small>{item.id}</small></span>
          </label>)}</div>
        </fieldset>
        <div className="memory-actions"><button type="button" className="primary" disabled={loading || saving || uncertain || !changed || draft.length > 8} onClick={() => void save([...draft])}>{saving ? '正在保存…' : '保存授权'}</button>
          <button type="button" className="secondary" disabled={loading || saving || uncertain || !policy.sourceConversationIds.length} onClick={() => void save([])}>撤销全部来源</button>
          {changed && <span className="muted small">有未保存的改动</span>}
        </div>
      </> : <p className="small">普通设备可查看授权，修改需使用拥有者管理设备。</p>}
    </>}
  </section>;
}
