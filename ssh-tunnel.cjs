// 프로젝트 실행에 필요한 SSH 포워딩을 연결하고 자식 프로세스와 함께 정리합니다.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function validateTunnel(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean') throw new Error('SSH 터널 설정 형식이 올바르지 않습니다.');
  if (!value.enabled) return { enabled: false };
  const result = { enabled: true };
  for (const key of ['host', 'remoteHost']) {
    if (typeof value[key] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(value[key])) throw new Error('SSH와 대상 호스트는 IPv4 주소 또는 호스트 이름을 입력해 주세요.');
    result[key] = value[key];
  }
  if (typeof value.user !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(value.user)) throw new Error('SSH 사용자 이름을 확인해 주세요.');
  result.user = value.user;
  if (typeof value.keyPath !== 'string' || !path.isAbsolute(value.keyPath) || /[\0\r\n]/.test(value.keyPath)) throw new Error('PEM 키의 절대 경로를 선택해 주세요.');
  result.keyPath = value.keyPath;
  for (const key of ['sshPort', 'localPort', 'remotePort']) {
    if (!/^\d+$/.test(String(value[key])) || !Number.isInteger(Number(value[key])) || Number(value[key]) < 1 || Number(value[key]) > 65535) throw new Error('SSH 포트는 1부터 65535 사이의 정수로 입력해 주세요.');
    result[key] = Number(value[key]);
  }
  return result;
}
class SshTunnel {
  constructor(config, { onFailure, sshPath = '/usr/bin/ssh', timeout = 15000 } = {}) {
    this.config = validateTunnel(config); this.onFailure = onFailure; this.sshPath = sshPath; this.timeout = timeout;
  }
  async open() {
    const c = this.config;
    try {
      const stat = await fs.stat(c.keyPath);
      if (!stat.isFile()) throw new Error('PEM 키는 파일이어야 합니다.');
      if (stat.mode & 0o077) throw new Error('PEM 키 권한이 너무 넓습니다. 파일 권한을 600 또는 400으로 설정해 주세요.');
      await fs.access(c.keyPath, require('node:fs').constants.R_OK);
      await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', () => reject(new Error(`SSH 터널의 ${c.localPort} 포트가 사용 중입니다. 기존 터널을 종료하거나 다른 포트를 선택해 주세요.`)));
        server.listen(c.localPort, '127.0.0.1', () => server.close(resolve));
      });
      this.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dl-ssh-'));
      this.control = path.join(this.directory, 's');
      const args = ['-F', '/dev/null', '-i', c.keyPath, '-p', String(c.sshPort), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=10', '-M', '-S', this.control, '-N', '-L', `127.0.0.1:${c.localPort}:${c.remoteHost}:${c.remotePort}`, `${c.user}@${c.host}`];
      const child = spawn(this.sshPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      this.child = child; this.output = '';
      child.stderr.on('data', data => { this.output = (this.output + data.toString()).slice(-4000); });
      this.exited = new Promise(resolve => {
        const fail = error => {
          this.failure = error; resolve();
          if (this.connected && !this.closing) this.onFailure?.(error);
        };
        child.once('error', error => fail(new Error(`SSH 터널 실행 실패. ${error.message}`)));
        child.once('exit', (code, signal) => fail(new Error(`SSH 터널이 종료되었습니다 (${signal || code}). ${this.output.trim()}`)));
      });
      const deadline = Date.now() + this.timeout;
      while (!this.failure && Date.now() < deadline) {
        try {
          await run(this.sshPath, ['-F', '/dev/null', '-S', this.control, '-O', 'check', `${c.user}@${c.host}`], { timeout: 1000 });
          if (this.failure) throw this.failure;
          this.connected = true; return;
        } catch { if (this.failure) break; }
        await delay(100);
      }
      throw this.failure || new Error('SSH 터널 연결 시간이 초과되었습니다. 호스트, 인증 키와 네트워크를 확인해 주세요.');
    } catch (error) { await this.close(); throw error; }
  }
  async close() {
    if (this.cleanup) return this.cleanup;
    this.closing = true;
    this.cleanup = (async () => {
      if (this.child && !this.failure) {
        this.child.kill('SIGTERM');
        await Promise.race([this.exited, delay(2000)]);
        if (!this.failure) { this.child.kill('SIGKILL'); await this.exited; }
      }
      if (this.directory) await fs.rm(this.directory, { recursive: true, force: true });
    })();
    return this.cleanup;
  }
}
module.exports = { SshTunnel, validateTunnel };
