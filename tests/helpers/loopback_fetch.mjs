/**
 * 测试用 loopback fetch 兼容层（发布门禁 `tools/run_browser_regression.py` 自动注入）。
 *
 * 背景：浏览器回归套件通过全局 fetch 调用测试内嵌 Python 服务的 127.0.0.1 端口。
 * Node 的 fetch（undici）会拒绝其“bad port”列表中的端口（2049/3659/4045/4190/
 * 5060/5061/6000/6566/6665-6669/6679/6697/10080 等）。而部分 Windows 机器的
 * TCP 动态端口范围被配置为 1024-14999，随机 bind(0) 的端口可能落入上述禁用段，
 * 造成偶发的 `fetch failed: bad port`（非产品问题）。
 *
 * 本模块把指向 `http://127.0.0.1:<port>` / `http://localhost:<port>` 的 fetch
 * 改用 `node:http` 实现（不受 bad-port 限制），其余请求沿用原生 fetch。
 * 由门禁通过 NODE_OPTIONS=--import=<fileURL> 预加载，不修改各套件源码。
 */
import http from 'node:http';

const realFetch = globalThis.fetch.bind(globalThis);

function isLoopback(url) {
  return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(\/|$)/i.test(url)
    || /^http:\/\/127\.0\.0\.1:\d+/i.test(url);
}

function httpFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const headers = {};
    for (const [key, value] of Object.entries(init.headers || {})) {
      headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    let body = init.body;
    if (body !== undefined && body !== null && typeof body !== 'string'
        && !(body instanceof Uint8Array) && !(body instanceof ArrayBuffer)) {
      try {
        body = JSON.stringify(body);
        if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json';
        }
      } catch {
        body = String(body);
      }
    }
    // 产品 HTTP 层要求 JSON 使用 Content-Length 提交；node:http 在无该头时
    // 会对流式 body 使用 chunked 编码，服务端会以 unsupported_transfer_encoding 拒绝。
    if (body !== undefined && body !== null
        && !Object.keys(headers).some(h => h.toLowerCase() === 'content-length')) {
      const length = typeof body === 'string' ? Buffer.byteLength(body)
        : (body.byteLength !== undefined ? body.byteLength : Buffer.byteLength(String(body)));
      headers['Content-Length'] = String(length);
    }
    const request = http.request({
      protocol: target.protocol,
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      method: (init.method || 'GET').toUpperCase(),
      headers,
      timeout: init.signal ? 0 : 30000,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) value.forEach(v => responseHeaders.append(key, v));
          else if (value !== undefined) responseHeaders.set(key, String(value));
        }
        resolve(new Response(text, {
          status: response.statusCode || 0,
          statusText: response.statusMessage || '',
          headers: responseHeaders,
        }));
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('loopback fetch timeout')));
    request.on('error', reject);
    if (init.signal) {
      if (init.signal.aborted) {
        request.destroy(new Error('loopback fetch aborted'));
      } else {
        init.signal.addEventListener('abort', () => request.destroy(new Error('loopback fetch aborted')), { once: true });
      }
    }
    if (body !== undefined && body !== null) request.write(body);
    request.end();
  });
}

globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  if (isLoopback(url)) return httpFetch(url, init || {});
  return realFetch(input, init);
};

export default globalThis.fetch;
