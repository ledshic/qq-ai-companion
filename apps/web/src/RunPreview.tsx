import { useEffect, useRef, useState } from 'react';
import type { createServiceClient } from '@companion/client/service';
import { APIError, type Run } from '@companion/contracts/service';

export function RunPreview({ client, run, onRun, onUnauthorized }: {
  client: ReturnType<typeof createServiceClient>; run: Run; onRun: (run: Run) => void; onUnauthorized: () => void;
}) {
  const [text, setText] = useState(''), [warning, setWarning] = useState(''), [retry, setRetry] = useState(0);
  const handlers = useRef({ onRun, onUnauthorized }); handlers.current = { onRun, onUnauthorized };
  useEffect(() => {
    const controller = new AbortController(); let alive = true;
    setText(''); setWarning('');
    const wait = () => new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, 1000); controller.signal.addEventListener('abort', done, { once: true });
    });
    void (async () => {
      for (let attempt = 0; attempt < 3 && alive; attempt++) {
        try {
          for await (const snapshot of client.watchRun(run.id, controller.signal)) {
            if (!alive) return;
            if (snapshot.run.conversationId !== run.conversationId) throw Error('scope_changed');
            setText(snapshot.text); setWarning(''); handlers.current.onRun(snapshot.run);
            if (!['queued', 'running'].includes(snapshot.run.state)) return;
          }
        } catch (error) {
          if (!alive) return;
          setText(''); setWarning('输出连接中断，正在读取最新状态。草稿未作为回答保存。');
          if (error instanceof APIError && [401, 403, 404].includes(error.status)) {
            if (error.status === 401) handlers.current.onUnauthorized();
            setWarning('当前输出不可访问，请检查连接或设备权限。'); return;
          }
        }
        if (attempt < 2 && alive) await wait();
      }
      if (alive) setWarning('输出暂不可用，任务状态仍由服务管理。可重新连接输出。');
    })();
    return () => { alive = false; controller.abort(); };
  }, [client, run.id, run.conversationId, retry]);
  return <article className="message assistant stream-preview" aria-label="生成中的回答">
    <div className="avatar" aria-hidden="true">…</div><div>
      <div className="message-meta" role="status">正在生成 · 未提交草稿</div>
      <div className="message-content">{text || '等待模型输出…'}</div>
      {warning && <p className="small" role="alert">{warning}<button type="button" className="secondary" onClick={() => setRetry(value => value + 1)}>重新连接输出</button></p>}
    </div>
  </article>;
}
