// desktop/loginSelfCheckRules.cjs
// 自检结果 → verdict（结论）。主进程与渲染层共用：渲染层直接 require 不了时
// 由 preload 以 IPC 桥接，这里只放纯函数（无 IO，可单测）。
//
// verdict 决策树按序短路：第一个命中的层就是「卡住的层」——
// backend-down → dns-failed → tls-reset / upstream-unreachable（分 v4/v6）
// → ipv6-failed（v4 通 v6 断）→ https-failed → clock-skew → network-ok。

const CLOCK_SKEW_WARN_MS = 5 * 60 * 1000; // 5 分钟以上才当作时钟问题

const errorText = (error) => (error ? `${error.code ?? 'error'}: ${error.message ?? ''}`.trim() : '');

const connectionMessage = (connection) => {
  if (!connection) return '';
  const where = connection.address ? `${connection.address} (IPv${connection.family})` : 'unknown address';
  const text = errorText(connection.error);
  return `${where}${text ? ` ${text}` : ''}${connection.error?.phase ? ` at ${connection.error.phase}` : ''}`;
};

// 一个 host 的连接全断：TLS 层被重置（ECONNRESET/ETIMEDOUT at tls）单独点名——
// 这是「上游拒绝这条链路」最常见形态，与「根本连不上」的排查方向不同。
const hostUnreachable = (hostResult) => {
  const connections = hostResult?.connections ?? [];
  if (connections.length === 0 || connections.some(item => !item.error)) return null;
  const tlsReset = connections.find(item => item.error?.phase === 'tls' && /ECONNRESET|ETIMEDOUT/i.test(item.error.code ?? ''));
  const first = tlsReset ?? connections[0];
  return {
    kind: tlsReset ? 'tls-reset' : 'upstream-unreachable',
    detail: `${hostResult.host} ${connectionMessage(first)}`,
  };
};

/** 跑自检结果 → { kind, detail?, proxyNote? }。 */
function verdictOfSelfCheck(result) {
  if (!result) return { kind: 'network-ok' };
  const backendError = result.backend && result.backend.status !== 'running'
    ? (result.backend.error || result.backend.status)
    : null;
  if (backendError) return { kind: 'backend-down', detail: String(backendError) };

  const dnsFailures = (result.hosts ?? []).filter(host => host.dns?.error);
  if (dnsFailures.length > 0) {
    return { kind: 'dns-failed', detail: dnsFailures.map(host => `${host.host}: ${errorText(host.dns.error)}`).join(', ') };
  }

  for (const host of result.hosts ?? []) {
    const unreachable = hostUnreachable(host);
    if (unreachable) return { ...unreachable, proxyNote: proxyNoteOf(result) };
  }

  // v4 通、v6 断：只有 IPv6 这条路被重置（常见于代理/防火墙只处理了 v4）
  for (const host of result.hosts ?? []) {
    const v4 = (host.connections ?? []).find(item => item.family === 4);
    const v6 = (host.connections ?? []).find(item => item.family === 6);
    if (v4 && !v4.error && v6?.error) {
      return { kind: 'ipv6-failed', detail: `${host.host} ${connectionMessage(v6)}`, proxyNote: proxyNoteOf(result) };
    }
  }

  const httpsFailure = (result.hosts ?? []).find(host => host.https?.error);
  if (httpsFailure) {
    return { kind: 'https-failed', detail: `${httpsFailure.host}: ${errorText(httpsFailure.https.error)}`, proxyNote: proxyNoteOf(result) };
  }

  const skewed = (result.hosts ?? []).find(host => Math.abs(host.https?.clockSkewMs ?? 0) > CLOCK_SKEW_WARN_MS);
  if (skewed) {
    return { kind: 'clock-skew', detail: `${Math.abs(Math.round((skewed.https.clockSkewMs ?? 0) / 60000))} 分钟` };
  }

  return { kind: 'network-ok', proxyNote: proxyNoteOf(result) };
}

// 代理警示（不改变 verdict，但界面要提示）：fake-ip = TUN 代理在接管；env = 环境变量里有代理。
function proxyNoteOf(result) {
  const hosts = result.hosts ?? [];
  if (hosts.some(host => host.dns?.fakeIp)) return 'fake-ip';
  if (Object.keys(result.proxy?.env ?? {}).length > 0) return 'env';
  return null;
}

/** 界面自检清单：每层一行 { id, state: 'ok'|'fail'|'warn'|'skip', detail? }。 */
function selfCheckChecklist(result) {
  if (!result) return [];
  const items = [];
  const backendError = result.backend && result.backend.status !== 'running'
    ? (result.backend.error || result.backend.status)
    : null;
  if (result.backend) {
    items.push({
      id: 'backend',
      state: backendError ? 'fail' : 'ok',
      detail: backendError
        ? String(backendError)
        : (result.backend.probe?.ok ? `GET / → HTTP ${result.backend.probe.httpStatus ?? '?'} (${result.backend.probe.durationMs}ms)` : null),
    });
  }

  const dnsFailure = (result.hosts ?? []).find(host => host.dns?.error);
  items.push((result.hosts ?? []).length === 0
    ? { id: 'dns', state: 'skip', detail: null }
    : {
      id: 'dns',
      state: dnsFailure ? 'fail' : 'ok',
      detail: dnsFailure ? `${dnsFailure.host}: ${errorText(dnsFailure.dns.error)}` : null,
    });

  const v4State = connectionFamilyState(result, 4);
  const v6State = connectionFamilyState(result, 6);
  items.push(v4State, v6State);

  const hosts = (result.hosts ?? []).filter(host => host.https);
  const httpsFailure = hosts.find(host => host.https?.error);
  items.push(hosts.length === 0
    ? { id: 'https', state: 'skip', detail: null }
    : {
      id: 'https',
      state: httpsFailure ? 'fail' : 'ok',
      detail: httpsFailure ? `${httpsFailure.host}: ${errorText(httpsFailure.https.error)}` : null,
    });

  const proxy = proxyNoteOf(result);
  items.push({
    id: 'proxy',
    state: proxy ? 'warn' : 'ok',
    detail: proxy === 'fake-ip'
      ? 'DNS 返回 198.18.0.0/15（TUN 代理在接管连接）'
      : proxy === 'env'
        ? Object.entries(result.proxy?.env ?? {}).map(([name, value]) => `${name}=${value}`).join(' ')
        : null,
  });

  const skews = (result.hosts ?? [])
    .map(host => host.https?.clockSkewMs)
    .filter(value => typeof value === 'number');
  const maxSkew = skews.reduce((acc, cur) => (Math.abs(cur) > Math.abs(acc) ? cur : acc), 0);
  items.push(skews.length === 0
    ? { id: 'clock', state: 'skip', detail: null }
    : Math.abs(maxSkew) > CLOCK_SKEW_WARN_MS
      ? { id: 'clock', state: 'warn', detail: `${Math.abs(Math.round(maxSkew / 60000))} 分钟` }
      : { id: 'clock', state: 'ok', detail: null });

  return items;
}

function connectionFamilyState(result, family) {
  const id = family === 4 ? 'ipv4' : 'ipv6';
  const connections = (result.hosts ?? []).flatMap(host => (host.connections ?? [])
    .filter(item => item.family === family)
    .map(item => ({ host: host.host, ...item })));
  if (connections.length === 0) return { id, state: 'skip', detail: null };
  const failed = connections.find(item => item.error);
  return failed
    ? { id, state: 'fail', detail: connectionMessage(failed) }
    : { id, state: 'ok', detail: null };
}

module.exports = { selfCheckChecklist, verdictOfSelfCheck };
