import { spawnSync } from 'node:child_process';

const API = 'https://my-study-agent-api.mystudyagent.workers.dev';

function readSecret(prompt) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error('请在交互式 PowerShell 终端运行此命令');
  }
  process.stdout.write(`${prompt} `);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = result => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stdout.write('\n');
      resolve(result);
    };
    const onData = chunk => {
      for (const byte of chunk) {
        if (byte === 3) {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          reject(new Error('已取消'));
          return;
        }
        if (byte === 13 || byte === 10) return finish(value);
        if (byte === 8 || byte === 127) value = value.slice(0, -1);
        else if (byte >= 32) value += String.fromCharCode(byte);
      }
    };
    process.stdin.on('data', onData);
  });
}

async function main() {
  const [action = 'help', ...args] = process.argv.slice(2);
  if (!['create', 'list', 'disable', 'usage', 'pricing'].includes(action)) {
    process.stdout.write('用法：node admin.mjs create [count] [days] [total] [daily]\n');
    process.stdout.write('      node admin.mjs list\n');
    process.stdout.write('      node admin.mjs disable <code-id>\n');
    process.stdout.write('      node admin.mjs usage\n');
    process.stdout.write('      node admin.mjs pricing <model> <input-usd-per-million> <output-usd-per-million>\n');
    return;
  }

  const token = await readSecret('管理员令牌（输入不回显）：');
  const headers = { 'x-admin-token': token };
  let url = action === 'usage' ? `${API}/admin/usage` : `${API}/admin/codes`;
  const options = { headers };
  if (action === 'create') {
    const [count = '1', days = '60', total = '300', daily = '30'] = args;
    options.method = 'POST';
    options.headers = { ...headers, 'content-type': 'application/json' };
    options.body = JSON.stringify({ count: Number(count), durationDays: Number(days), requestLimit: Number(total), dailyRequestLimit: Number(daily) });
  } else if (action === 'list') {
    url += '?limit=200';
  } else if (action === 'disable') {
    if (!args[0]) throw new Error('disable 命令需要兑换码记录 ID');
    url += `/${encodeURIComponent(args[0])}/disable`;
    options.method = 'POST';
  } else if (action === 'pricing') {
    const [model, inputUsdPerMillion, outputUsdPerMillion] = args;
    options.method = 'POST';
    options.headers = { ...headers, 'content-type': 'application/json' };
    options.body = JSON.stringify({ model, inputUsdPerMillion: Number(inputUsdPerMillion), outputUsdPerMillion: Number(outputUsdPerMillion) });
    url = `${API}/admin/pricing`;
  }

  let result;
  if (process.platform === 'win32') {
    const script = [
      "$headers = @{ 'x-admin-token' = $env:MSA_ADMIN_TOKEN }",
      "$params = @{ Uri = $env:MSA_ADMIN_URL; Method = $env:MSA_ADMIN_METHOD; Headers = $headers; TimeoutSec = 60 }",
      "if ($env:MSA_ADMIN_BODY) { $params.ContentType = 'application/json'; $params.Body = $env:MSA_ADMIN_BODY }",
      'try { Invoke-RestMethod @params | ConvertTo-Json -Depth 20 -Compress }',
      'catch { $response = $_.Exception.Response; if ($response) { $reader = New-Object System.IO.StreamReader($response.GetResponseStream()); $body = $reader.ReadToEnd(); [Console]::Error.WriteLine("HTTP " + [int]$response.StatusCode + ": " + $body) } else { [Console]::Error.WriteLine($_.Exception.Message) }; exit 1 }',
    ].join('\n');
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript], {
      encoding: 'utf8',
      timeout: 70000,
      env: {
        ...process.env,
        MSA_ADMIN_TOKEN: token,
        MSA_ADMIN_URL: url,
        MSA_ADMIN_METHOD: options.method || 'GET',
        MSA_ADMIN_BODY: options.body || '',
      },
      windowsHide: true,
    });
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error((child.stderr || '管理请求失败').trim());
    try { result = JSON.parse(child.stdout); }
    catch { throw new Error('PowerShell 返回了无法解析的响应'); }
  } else {
    let response;
    try {
      response = await fetch(url, options);
    } catch (error) {
      throw new Error(`无法连接 Worker：${error.message || String(error)}`);
    }
    result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `请求失败 (${response.status})`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.message || String(error)}\n`);
  process.exitCode = 1;
});
