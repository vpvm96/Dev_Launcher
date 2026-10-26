// 프로세스 출력을 줄 단위로 보관하고 화면이 새로 추가된 줄만 가져가도록 한다.
let epochs = 0;
class LogBuffer {
  constructor(limit = 5000) { this.limit = limit; this.clear(); }
  clear() { this.epoch = ++epochs; this.lines = []; this.next = 0; this.partial = ''; this.partialTime = null; }
  push(chunk) {
    const parts = (this.partial + chunk).split('\n');
    const now = Date.now();
    for (const text of parts.slice(0, -1)) { this.lines.push({ seq: this.next++, time: this.partialTime ?? now, text }); this.partialTime = null; }
    this.partial = parts.at(-1).slice(-100000);
    this.partialTime = this.partial ? this.partialTime ?? now : null;
    if (this.lines.length > this.limit) this.lines.splice(0, this.lines.length - this.limit);
  }
  text(map = text => text) {
    return [...this.lines.map(line => map(line.text)), map(this.partial)].join('\n');
  }
  // cursor는 마지막으로 받은 줄 번호입니다. 버퍼가 비워졌거나 오래된 줄이 잘렸으면 전체를 다시 보냅니다.
  since(cursor, map = text => text) {
    const first = this.lines[0]?.seq ?? this.next;
    const reset = !cursor || cursor.epoch !== this.epoch || cursor.seq < first - 1;
    const from = reset ? 0 : this.lines.findIndex(line => line.seq > cursor.seq);
    const lines = from < 0 ? [] : this.lines.slice(from).map(line => map(line.text));
    return { cursor: { epoch: this.epoch, seq: this.next - 1 }, reset, lines, partial: map(this.partial) };
  }
}
module.exports = { LogBuffer };
