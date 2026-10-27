import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { createMockClient, DEFAULT_MOCK_URL } from '@companion/client';
import type { ClientInfo, MockStatus, ProbeResult } from '@companion/contracts';
const id = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
async function clientInfo(): Promise<ClientInfo> {
  if (isTauri())
    return {
      ...(await invoke<Omit<ClientInfo, 'environment'>>('client_info')),
      environment: 'tauri',
    };
  return {
    platform: 'browser',
    architecture: 'web',
    version: '0.1.0',
    environment: 'web',
  };
}
export function App() {
  const [address, setAddress] = useState(
    new URLSearchParams(location.search).get('api') ?? DEFAULT_MOCK_URL,
  );
  const [message, setMessage] = useState('你好，来自客户端的连接验证');
  const [info, setInfo] = useState<ClientInfo>();
  const [status, setStatus] = useState<MockStatus>();
  const [result, setResult] = useState<ProbeResult>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const identity = useRef(id());
  const active = useRef<AbortController | undefined>(undefined);
  const verify = async (endpoint: string, text: string) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const timer = setTimeout(
      () => controller.abort(Error('连接超时，请检查模拟服务地址')),
      8000,
    );
    setBusy(true);
    setError('');
    setStatus(undefined);
    setResult(undefined);
    try {
      const client = createMockClient(endpoint);
      const platform = await clientInfo();
      setInfo(platform);
      const health = await client.status(controller.signal);
      const reply = await client.probe(
        {
          clientId: identity.current,
          requestId: id(),
          client: platform,
          message: text,
        },
        controller.signal,
      );
      if (controller !== active.current || controller.signal.aborted) return;
      setStatus(health);
      setResult(reply);
    } catch (reason) {
      if (controller === active.current)
        setError(reason instanceof Error ? reason.message : '连接失败，请重试');
    } finally {
      clearTimeout(timer);
      if (controller === active.current) setBusy(false);
    }
  };
  useEffect(() => {
    void verify(address, message);
    return () => {
      active.current?.abort();
      active.current = undefined;
    };
  }, []);
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="#">
          <span className="brand-icon">c</span>companion
          <span className="phase">A</span>
        </a>
        <div className="nav-label">CLIENT LAB</div>
        <div className="nav-item">
          <span>◉</span>连接验证
        </div>
        <div className="sidebar-note">
          同一个 Agent，
          <br />
          连接每一个终端。<small>Web · Desktop · Mobile</small>
        </div>
      </aside>
      <main>
        <header>
          <span className="eyebrow">个人 Agent / 客户端构建验证</span>
          <span className="badge">模拟环境</span>
        </header>
        <section className="intro">
          <p className="section-no">01 / CONNECTION</p>
          <h1>
            先连接，
            <br className="mobile-break" />
            再开始。
          </h1>
          <p>
            验证界面与常驻服务之间的往返通信。
            <br />
            此工程不连接 QQ、模型或真实记忆。
          </p>
        </section>
        <div className="cards">
          <section className="card connection">
            <div className="card-title">
              <h2>服务连接</h2>
              <span
                className={'state ' + (status ? 'ok' : error ? 'failed' : '')}
              >
                {busy
                  ? '正在验证'
                  : status
                    ? '连接通过'
                    : error
                      ? '连接失败'
                      : '未连接'}
              </span>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void verify(address, message);
              }}
            >
              <label htmlFor="endpoint">模拟 API 地址</label>
              <input
                id="endpoint"
                type="url"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                required
              />
              <p className="hint">
                Android 模拟器使用 10.0.2.2，或先设置 adb reverse。
              </p>
              <label htmlFor="probe">验证消息</label>
              <textarea
                id="probe"
                maxLength={200}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                required
              />
              <button type="submit" disabled={busy || !message.trim()}>
                {busy ? '连接中…' : '验证连接'}
                <span>↗</span>
              </button>
            </form>
            {error && (
              <div role="alert" className="error">
                {error}
              </div>
            )}
          </section>
          <section className="card receipt">
            <div className="card-title">
              <h2>服务回执</h2>
              <span className="receipt-icon">↙</span>
            </div>
            <div
              className={'reply ' + (result ? 'received' : '')}
              role="status"
            >
              {result ? result.reply : '等待模拟服务回应'}
            </div>
            <dl>
              <div>
                <dt>客户端</dt>
                <dd data-testid="platform">
                  {info ? `${info.environment} / ${info.platform}` : '识别中'}
                </dd>
              </div>
              <div>
                <dt>Agent</dt>
                <dd>模拟运行时</dd>
              </div>
              <div>
                <dt>QQ / 模型</dt>
                <dd>未连接 / 未配置</dd>
              </div>
              <div>
                <dt>接收时间</dt>
                <dd>
                  {result
                    ? new Date(result.receivedAt).toLocaleTimeString()
                    : '—'}
                </dd>
              </div>
              <div>
                <dt>回执编号</dt>
                <dd className="mono" data-testid="probe-id">
                  {result?.probeId ?? '—'}
                </dd>
              </div>
            </dl>
            <p className="receipt-note">
              客户端仅展示服务状态与结果。
              <br />
              关闭界面不会停止服务。
            </p>
          </section>
        </div>
        <footer>
          PHASE A <span>构建与连接验证 · 在线客户端</span>
        </footer>
      </main>
    </div>
  );
}
