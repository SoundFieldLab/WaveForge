// desktop/qqLoginFailure.cjs
// QQ 音乐登录失败分类：把上游错误（upstreamCode / globalCode / phase / message）
// 归类成界面可解释的 failureHint（case + 用户可读文案 + 是否可重试）。
//
// 分类依据：
// - 20279（auth.device-limit）：扫码确认时 QQ 音乐报「设备数量已达上限」——最常见、
//   也最容易被误报成「二维码过期」的一类（上游返回码 800 只表示本轮扫码失败，
//   真实原因在凭据交换/扫码确认的上游码里）；
// - 432：频率限制（扫码轮询过快），带 retryAfterMs；
// - 2001/2002 类：QQ 音乐风控（环境异常），换网络/稍后再试；
// - 凭据交换阶段（credential-exchange）的非零 upstreamCode：登录被上游明确拒绝。
//
// 这张表只做「上游码 → 界面语言」的映射，不做网络探测（那是 loginSelfCheck 的职责）。

const FAILURE_CASES = Object.freeze({
  DEVICE_LIMIT: 'device-limit',
  ACCOUNT_RESTRICTED: 'account-restricted',
  ACCOUNT_BANNED: 'account-banned',
  RATE_LIMITED: 'rate-limited',
  WRONG_SCAN_APP: 'wrong-scan-app',
  REFUSED: 'refused',
  NETWORK: 'unreachable',
  EXPIRED: 'qr-expired',
  CANCELED: 'canceled',
  UNKNOWN: 'unknown',
});

const CASE_TITLES = Object.freeze({
  [FAILURE_CASES.DEVICE_LIMIT]: 'QQ音乐账号登录的设备已达上限',
  [FAILURE_CASES.ACCOUNT_RESTRICTED]: 'QQ音乐账号受到登录限制',
  [FAILURE_CASES.ACCOUNT_BANNED]: 'QQ音乐账号已被封禁',
  [FAILURE_CASES.RATE_LIMITED]: '操作过于频繁',
  [FAILURE_CASES.WRONG_SCAN_APP]: '请使用 QQ 音乐 App 扫码',
  [FAILURE_CASES.REFUSED]: 'QQ音乐拒绝了本次登录',
  [FAILURE_CASES.NETWORK]: '网络连接失败',
  [FAILURE_CASES.EXPIRED]: '二维码已过期',
  [FAILURE_CASES.CANCELED]: '扫码登录已取消',
  [FAILURE_CASES.UNKNOWN]: '扫码登录失败',
});

const CASE_GUIDANCE = Object.freeze({
  [FAILURE_CASES.DEVICE_LIMIT]: '请打开 QQ 音乐 App，进入「设置」，滑到最下面点「设备管理」，移除不用的设备后重新扫码。',
  [FAILURE_CASES.ACCOUNT_RESTRICTED]: '该账号近期有异常登录行为。请先用 QQ 音乐 App 正常登录一次，再回来扫码。',
  [FAILURE_CASES.ACCOUNT_BANNED]: '请联系 QQ 音乐客服确认账号状态。',
  [FAILURE_CASES.RATE_LIMITED]: '稍等片刻（约 1 分钟）再重新扫码，不要连续快速刷新二维码。',
  [FAILURE_CASES.WRONG_SCAN_APP]: '本次扫码通道只认 QQ 音乐 App。请用 QQ 音乐 App（而不是微信/QQ）重新扫码。',
  [FAILURE_CASES.REFUSED]: '在手机上确认登录时选择了拒绝，或账号状态不允许。请重试并确认授权。',
  [FAILURE_CASES.NETWORK]: '与 QQ 音乐服务器的连接中断。检查网络/代理后重试；详情可用「网络自检」确认。',
  [FAILURE_CASES.EXPIRED]: '二维码超时未扫，请刷新后重新扫码。',
  [FAILURE_CASES.CANCELED]: '本次扫码已取消，可重新开始。',
  [FAILURE_CASES.UNKNOWN]: '原因未知。可用「网络自检」排除本地网络问题，或复制诊断信息反馈。',
});

// 上游码（凭据交换/扫码确认阶段出现）→ case
const UPSTREAM_CODE_MAP = Object.freeze({
  20279: FAILURE_CASES.DEVICE_LIMIT,
  432: FAILURE_CASES.RATE_LIMITED,
  2001: FAILURE_CASES.ACCOUNT_RESTRICTED,
  2002: FAILURE_CASES.ACCOUNT_RESTRICTED,
  1600701: FAILURE_CASES.ACCOUNT_BANNED,
});

/**
 * 从一次失败的错误/结果里推出 failureHint。
 * error 形状（callMusicu 抛出）：{ phase, httpStatus, globalCode, upstreamCode, upstreamBody, message }；
 * result 形状（扫码轮询返回）：{ status: 'error'|'expired', message, code? }。
 * 返回 null 表示该失败不值得分类（如普通轮询网络抖动）。
 */
function classifyQqLoginFailure(error) {
  if (!error || typeof error !== 'object') return null;
  const upstreamCode = Number(error.upstreamCode);
  const globalCode = Number(error.globalCode);
  const phase = typeof error.phase === 'string' ? error.phase : '';
  const message = String(error.message ?? '');

  // 网络层失败：没有拿到任何 HTTP 响应（callMusicu 的 postJson 在网络错误时带 code）
  if (typeof error.code === 'string' && /^(ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ESOCKETTIMEDOUT)/i.test(error.code)) {
    return hint(FAILURE_CASES.NETWORK, { upstreamCode: null, globalCode: null, phase, message: error.message });
  }

  // 上游明确拒绝（凭据交换/扫码确认里的真实业务码）
  if (Number.isFinite(upstreamCode) && upstreamCode !== 0) {
    const known = UPSTREAM_CODE_MAP[upstreamCode];
    if (known) {
      return hint(known, { upstreamCode, globalCode, phase, message });
    }
    // 凭据交换阶段的未知名码也是「上游拒绝」，只是没有专门文案
    if (/credential/i.test(phase)) {
      return hint(FAILURE_CASES.REFUSED, { upstreamCode, globalCode, phase, message });
    }
    return null;
  }

  // HTTP 状态异常（5xx = 上游暂时不可用）
  const httpStatus = Number(error.httpStatus);
  if (Number.isFinite(httpStatus) && httpStatus >= 500) {
    return hint(FAILURE_CASES.NETWORK, { upstreamCode: null, globalCode, phase, message: `HTTP ${httpStatus}` });
  }

  // 手机端拒绝（MQTT 事件 loginFailed 在外层已归为 expired；这里兜住显式文案）
  if (/拒绝|denied|refused/i.test(message)) {
    return hint(FAILURE_CASES.REFUSED, { upstreamCode: null, globalCode, phase, message });
  }
  return null;
}

function hint(caseName, { upstreamCode = null, globalCode = null, phase = '', message = '' } = {}) {
  return {
    case: caseName,
    title: CASE_TITLES[caseName],
    guidance: CASE_GUIDANCE[caseName],
    retryable: caseName === FAILURE_CASES.RATE_LIMITED || caseName === FAILURE_CASES.NETWORK || caseName === FAILURE_CASES.EXPIRED,
    retryAfterMs: caseName === FAILURE_CASES.RATE_LIMITED ? 60_000 : null,
    upstreamCode,
    globalCode,
    phase,
    message: String(message ?? '').slice(0, 200),
  };
}

module.exports = { FAILURE_CASES, CASE_TITLES, CASE_GUIDANCE, classifyQqLoginFailure };
