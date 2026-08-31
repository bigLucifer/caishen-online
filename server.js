/**
 * 财神大战 · 联机对战服务端
 * Node.js + ws + http(静态)
 *
 * 权威规则；客户端只做展示。手牌按人下发。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

// -------- 静态文件服务（同一端口跑 http + ws） --------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.ico':  'image/x-icon',
};
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const mime = MIME[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

// -------- 游戏规则（权威） --------
const FACTIONS = ['qinglong','baihu','zhuque','xuanwu'];

function buildDeck() {
  const d = [];
  FACTIONS.forEach(f => { for (let n=1; n<=13; n++) d.push({ t:'normal', f, n }); });
  for (let i=0; i<4; i++) d.push({ t:'caishen' });
  for (let i=0; i<4; i++) d.push({ t:'qionggui' });
  for (let i = d.length-1; i>0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function getLeadFaction(trick) {
  for (const p of trick) {
    if (p.card.t === 'caishen') return null;
    if (p.card.t === 'normal') return p.card.f;
  }
  return null;
}

function decideTrickWinner(trick, leadFaction, trump) {
  const firstCaishen = trick.findIndex(p => p.card.t === 'caishen');
  if (firstCaishen !== -1) return trick[firstCaishen].seat;
  const allQ = trick.every(p => p.card.t === 'qionggui');
  if (allQ) return trick[0].seat;
  let winner = null;
  if (trump) {
    trick.forEach(p => {
      if (p.card.t === 'normal' && p.card.f === trump) {
        if (!winner || p.card.n > winner.card.n) winner = p;
      }
    });
    if (winner) return winner.seat;
  }
  trick.forEach(p => {
    if (p.card.t === 'normal' && p.card.f === leadFaction) {
      if (!winner || p.card.n > winner.card.n) winner = p;
    }
  });
  if (winner) return winner.seat;
  return trick[0].seat;
}

function isCardLegal(hand, cardIdx, currentTrick) {
  const card = hand[cardIdx];
  if (!card) return false;
  if (card.t === 'caishen' || card.t === 'qionggui') return true;
  if (currentTrick.length === 0) return true;
  const lead = getLeadFaction(currentTrick);
  if (!lead) return true;
  const hasLead = hand.some(c => c.t === 'normal' && c.f === lead);
  if (!hasLead) return true;
  return card.t === 'normal' && card.f === lead;
}

// -------- 房间对象 --------
class Room {
  constructor(code) {
    this.code = code;
    this.players = []; // { id, name, ws, seat, connected }
    this.hostId = null;
    this.state = 'waiting'; // waiting | playing | roundend | gameend
    this.round = 0;
    this.totalRounds = 0;
    this.dealerSeat = 0;
    this.roundLeadSeat = 0;
    this.turnSeat = 0;
    this.trump = null;
    this.hands = [];
    this.bids = [];
    this.wins = [];
    this.scores = [];
    this.currentTrick = [];
    this.pendingBidSeat = 0;
    this.lastDeltas = [];
    this.log = [];
  }

  addPlayer(id, name, ws) {
    if (this.state !== 'waiting') return { err: '游戏已开始，不能加入' };
    if (this.players.length >= 6) return { err: '房间已满（最多 6 人）' };
    if (this.players.some(p => p.name === name)) return { err: '昵称已存在，请换一个' };
    const seat = this.players.length;
    const p = { id, name, ws, seat, connected: true, isAI: false };
    this.players.push(p);
    if (this.hostId == null) this.hostId = id;
    return { seat };
  }

  addAI() {
    if (this.state !== 'waiting') return { err: '游戏已开始，不能加 AI' };
    if (this.players.length >= 6) return { err: '房间已满' };
    // AI 昵称：机器·关羽/李逵/孙悟空/林黛玉/贾宝玉/诸葛亮
    const pool = ['关羽','李逵','孙悟空','林黛玉','贾宝玉','诸葛亮','武则天','唐僧'];
    let idx = 0;
    let name;
    do {
      name = '机器·' + pool[idx % pool.length];
      idx++;
    } while (this.players.some(p => p.name === name) && idx < 100);
    const seat = this.players.length;
    const p = { id: 'ai_' + Math.random().toString(36).slice(2,10), name, ws: null, seat, connected: true, isAI: true };
    this.players.push(p);
    return { seat };
  }

  removeAIAt(seat) {
    if (this.state !== 'waiting') return { err: '游戏中不能删 AI' };
    const idx = this.players.findIndex(p => p.seat === seat && p.isAI);
    if (idx < 0) return { err: '该座位不是 AI' };
    this.players.splice(idx, 1);
    this.players.forEach((p, i) => p.seat = i);
    return {};
  }

  removePlayer(id) {
    const idx = this.players.findIndex(p => p.id === id);
    if (idx < 0) return;
    if (this.state === 'waiting') {
      // 等待阶段直接移除
      this.players.splice(idx, 1);
      this.players.forEach((p, i) => p.seat = i);
      if (this.players.length && !this.players.find(p => p.id === this.hostId)) {
        this.hostId = this.players[0].id;
      }
    } else {
      // 游戏中标记为断开，保留座位
      this.players[idx].connected = false;
    }
  }

  reconnect(id, ws) {
    const p = this.players.find(x => x.id === id);
    if (!p) return false;
    p.ws = ws;
    p.connected = true;
    return true;
  }

  start() {
    const n = this.players.length;
    if (n < 3) return { err: '至少 3 人才能开局' };
    this.state = 'playing';
    this.totalRounds = Math.floor(60 / n);
    this.round = 1;
    this.dealerSeat = 0;
    this.scores = this.players.map(() => 0);
    this._dealRound();
    return {};
  }

  _dealRound() {
    const n = this.players.length;
    const deck = buildDeck();
    this.hands = this.players.map(() => deck.splice(0, this.round));
    if (deck.length === 0) {
      this.trump = null;
    } else {
      const top = deck[0];
      if (top.t === 'caishen') {
        // 发牌者自选一个王牌花色（简化：选自己手牌最多的花色）
        const cnt = { qinglong:0, baihu:0, zhuque:0, xuanwu:0 };
        this.hands[this.dealerSeat].forEach(c => { if (c.t==='normal') cnt[c.f]++; });
        let best = 'qinglong', mx = -1;
        Object.keys(cnt).forEach(f => { if (cnt[f]>mx){mx=cnt[f]; best=f;} });
        this.trump = best;
      } else if (top.t === 'qionggui') {
        this.trump = null;
      } else {
        this.trump = top.f;
      }
    }
    this.bids = this.players.map(() => null);
    this.wins = this.players.map(() => 0);
    this.currentTrick = [];
    this.roundLeadSeat = (this.dealerSeat + 1) % n;
    this.turnSeat = this.roundLeadSeat;
    this.pendingBidSeat = 0; // getBidOrder 里的索引
    this.state = 'playing';
  }

  getBidOrder() {
    const n = this.players.length;
    const order = [];
    for (let i=1; i<=n; i++) order.push((this.dealerSeat + i) % n);
    return order;
  }

  submitBid(seat, bid) {
    if (this.state !== 'playing') return { err: '当前不在游戏阶段' };
    const order = this.getBidOrder();
    const currentBidder = order[this.pendingBidSeat];
    if (currentBidder !== seat) return { err: '还没轮到你押把' };
    if (this.bids[seat] != null) return { err: '你已经押过了' };
    const handSize = this.hands[seat].length;
    if (typeof bid !== 'number' || bid < 0 || bid > handSize || !Number.isInteger(bid)) {
      return { err: '押把数无效' };
    }
    this.bids[seat] = bid;
    this.pendingBidSeat++;
    return {};
  }

  playCard(seat, cardIdx) {
    if (this.state !== 'playing') return { err: '当前不在游戏阶段' };
    if (this.pendingBidSeat < this.players.length) return { err: '还没所有人押完把' };
    if (this.turnSeat !== seat) return { err: '还没轮到你出牌' };
    if (!isCardLegal(this.hands[seat], cardIdx, this.currentTrick)) {
      return { err: '此牌不合法：必须跟首出阵营' };
    }
    const card = this.hands[seat].splice(cardIdx, 1)[0];
    this.currentTrick.push({ seat, card });
    const n = this.players.length;
    if (this.currentTrick.length === n) {
      // 一把结束，结算
      const lead = getLeadFaction(this.currentTrick);
      const winner = decideTrickWinner(this.currentTrick, lead, this.trump);
      this.wins[winner]++;
      this.log.push(`${this.players[winner].name} 吃下这一把`);
      // 关键规则：每把结束后先出者不变（回到 roundLeadSeat）
      // 交给 advanceAfterTrick() 走
      return { trickDone: true, winner };
    } else {
      this.turnSeat = (this.turnSeat + 1) % n;
      return { trickDone: false };
    }
  }

  advanceAfterTrick() {
    // 由调用方在客户端展示完"这把谁赢"后调用
    this.currentTrick = [];
    this.turnSeat = this.roundLeadSeat; // 一轮内先出永不变
    if (this.hands[0].length === 0) {
      // 一轮结束，结算
      this.lastDeltas = this.players.map((p, i) => {
        const bid = this.bids[i], win = this.wins[i];
        const d = (bid === win) ? (20 + win*10) : -Math.abs(bid-win)*10;
        this.scores[i] += d;
        return d;
      });
      this.state = 'roundend';
    }
  }

  nextRound() {
    if (this.state !== 'roundend') return { err: '当前不在结算阶段' };
    const n = this.players.length;
    this.round++;
    if (this.round > this.totalRounds) {
      this.state = 'gameend';
      return {};
    }
    this.dealerSeat = (this.dealerSeat + 1) % n;
    this._dealRound();
    return {};
  }

  // ---- 服务端 AI 决策 ----
  aiCalcBid(seat) {
    const hand = this.hands[seat];
    let expected = 0;
    hand.forEach(c => {
      if (c.t === 'caishen') expected += 1;
      else if (c.t === 'qionggui') expected += 0;
      else if (this.trump && c.f === this.trump && c.n >= 8) expected += 0.7;
      else if (c.n >= 11) expected += 0.5;
    });
    let bid = Math.round(expected);
    const priorSum = this.bids.reduce((s,b) => s + (b||0), 0);
    const remaining = hand.length - priorSum;
    if (remaining <= 0) bid = Math.max(0, bid - 1);
    if (bid < 0) bid = 0;
    if (bid > hand.length) bid = hand.length;
    return bid;
  }

  aiCalcPlay(seat) {
    const hand = this.hands[seat];
    const legal = hand.map((_,i)=>i).filter(i => isCardLegal(hand, i, this.currentTrick));
    if (legal.length === 0) return 0;
    const need = this.bids[seat] - this.wins[seat];
    const remaining = hand.length;
    const wantWin = need > 0 && need >= (remaining - need);
    const strength = c => c.t==='caishen'?100 : c.t==='qionggui'?-1 : c.n;
    const sorted = legal.slice().sort((a,b) => strength(hand[a]) - strength(hand[b]));
    return wantWin ? sorted[sorted.length-1] : sorted[0];
  }

  // 生成推送给某座位的视图（其他人手牌数字不可见，只显示"?"张数）
  viewFor(seat) {
    return {
      code: this.code,
      state: this.state,
      round: this.round,
      totalRounds: this.totalRounds,
      dealerSeat: this.dealerSeat,
      roundLeadSeat: this.roundLeadSeat,
      turnSeat: this.turnSeat,
      trump: this.trump,
      hostId: this.hostId,
      pendingBidSeat: this.pendingBidSeat,
      players: this.players.map(p => ({
        seat: p.seat, name: p.name,
        connected: p.connected, isHost: p.id === this.hostId,
        isAI: p.isAI || false,
      })),
      bids: this.bids,           // 公开
      wins: this.wins,
      scores: this.scores,
      handSizes: this.hands.map(h => h.length),
      myHand: seat != null ? this.hands[seat] : null,
      currentTrick: this.currentTrick,
      lastDeltas: this.lastDeltas,
      log: this.log.slice(-8),
      bidOrder: this.getBidOrder(),
    };
  }
}

// -------- 房间管理 --------
const rooms = new Map(); // code -> Room
function genCode() {
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  while (true) {
    let c = '';
    for (let i=0; i<4; i++) c += alpha[Math.floor(Math.random()*alpha.length)];
    if (!rooms.has(c)) return c;
  }
}

// -------- WebSocket --------
const wss = new WebSocketServer({ server });

// 全局广播（AI 调度器也要用）
function broadcast(room) {
  room.players.forEach(p => {
    if (!p.isAI && p.connected && p.ws && p.ws.readyState === 1) {
      try { p.ws.send(JSON.stringify({ type: 'state', view: room.viewFor(p.seat) })); } catch(e){}
    }
  });
}

// AI 自动出手：改成"每个房间一个持续轮询定时器"，简单可靠
const _aiTimers = new Map(); // roomCode -> interval id
function startAILoop(room) {
  if (_aiTimers.has(room.code)) return; // 已有循环
  const interval = setInterval(() => {
    // 房间不存在 or 结束 → 停
    if (!rooms.has(room.code)) { clearInterval(interval); _aiTimers.delete(room.code); return; }
    if (room.state === 'gameend') { clearInterval(interval); _aiTimers.delete(room.code); return; }

    // 非游戏中（等待/结算）→ 什么都不做，等下次轮询
    if (room.state !== 'playing') return;

    // 押把阶段：如果当前该押的是 AI，就替它押
    if (room.pendingBidSeat < room.players.length) {
      const seat = room.getBidOrder()[room.pendingBidSeat];
      const p = room.players[seat];
      if (p && p.isAI) {
        const bid = room.aiCalcBid(seat);
        const r = room.submitBid(seat, bid);
        if (r.err) {
          console.warn(`AI ${p.name} 押把失败:`, r.err);
          room.submitBid(seat, 0); // 兜底
        }
        broadcast(room);
      }
      return;
    }

    // 出牌阶段：若当前该出的是 AI 且未打完
    if (room.currentTrick.length < room.players.length) {
      const seat = room.turnSeat;
      const p = room.players[seat];
      if (p && p.isAI) {
        const cardIdx = room.aiCalcPlay(seat);
        const r = room.playCard(seat, cardIdx);
        if (r.err) {
          console.warn(`AI ${p.name} 出牌失败:`, r.err);
          // 兜底：出第一张合法牌
          const hand = room.hands[seat];
          for (let i = 0; i < hand.length; i++) {
            if (isCardLegal(hand, i, room.currentTrick)) {
              const r2 = room.playCard(seat, i);
              if (!r2.err) { broadcast(room); if (r2.trickDone) scheduleAdvance(room); return; }
            }
          }
          console.error(`AI ${p.name} 无法出任何牌，跳过`);
          return;
        }
        broadcast(room);
        if (r.trickDone) scheduleAdvance(room);
      }
      return;
    }
    // 3 张都在 trick → 等 advance 定时器
  }, 800);
  _aiTimers.set(room.code, interval);
}

// 独立的推进定时器：每次 trick 满员后 1.5s 结算并 advance
const _advanceTimers = new Map();
function scheduleAdvance(room) {
  if (_advanceTimers.has(room.code)) return;
  const t = setTimeout(() => {
    _advanceTimers.delete(room.code);
    if (!rooms.has(room.code)) return;
    room.advanceAfterTrick();
    broadcast(room);
  }, 1500);
  _advanceTimers.set(room.code, t);
}

function stopAILoop(room) {
  if (_aiTimers.has(room.code)) { clearInterval(_aiTimers.get(room.code)); _aiTimers.delete(room.code); }
  if (_advanceTimers.has(room.code)) { clearTimeout(_advanceTimers.get(room.code)); _advanceTimers.delete(room.code); }
}

// 兼容旧调用名
function scheduleAI(room) { if (room) startAILoop(room); }

wss.on('connection', (ws) => {
  ws.id = Math.random().toString(36).slice(2, 12);
  ws.roomCode = null;
  ws.seat = null;

  const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch(e){} };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch(e) { return; }

    if (msg.type === 'create') {
      const name = (msg.name || '玩家').slice(0, 12);
      const code = genCode();
      const room = new Room(code);
      rooms.set(code, room);
      const r = room.addPlayer(ws.id, name, ws);
      if (r.err) return send({ type: 'error', msg: r.err });
      ws.roomCode = code; ws.seat = r.seat;
      send({ type: 'joined', code, seat: r.seat, myId: ws.id });
      broadcast(room);
      return;
    }

    if (msg.type === 'join') {
      const code = (msg.room || '').toUpperCase();
      const name = (msg.name || '玩家').slice(0, 12);
      const room = rooms.get(code);
      if (!room) return send({ type: 'error', msg: '房间不存在' });

      // 1) 优先：myId 精确匹配 → 直接回座位
      if (msg.myId) {
        const p = room.players.find(pl => pl.id === msg.myId);
        if (p) {
          room.reconnect(msg.myId, ws);
          ws.id = msg.myId; ws.roomCode = code; ws.seat = p.seat;
          send({ type: 'joined', code, seat: p.seat, myId: ws.id, reconnect: true });
          broadcast(room);
          return;
        }
      }

      // 2) 兜底：按昵称回座位（换设备/清缓存/退出重进都能回来）
      const offlinePeer = room.players.find(pl => pl.name === name && !pl.connected);
      if (offlinePeer) {
        const oldId = offlinePeer.id;
        offlinePeer.id = ws.id;
        offlinePeer.ws = ws;
        offlinePeer.connected = true;
        // 房主身份跟着新 id 转移
        if (room.hostId === oldId) room.hostId = ws.id;
        ws.roomCode = code; ws.seat = offlinePeer.seat;
        send({ type: 'joined', code, seat: offlinePeer.seat, myId: ws.id, reconnect: true });
        broadcast(room);
        return;
      }

      // 3) 新玩家
      const r = room.addPlayer(ws.id, name, ws);
      if (r.err) {
        if (r.err.includes('游戏已开始')) {
          return send({ type: 'error', msg: '房间在游戏中，如你是掉线请用相同昵称重新加入' });
        }
        return send({ type: 'error', msg: r.err });
      }
      ws.roomCode = code; ws.seat = r.seat;
      send({ type: 'joined', code, seat: r.seat, myId: ws.id });
      broadcast(room);
      return;
    }

    const room = rooms.get(ws.roomCode);
    if (!room) return send({ type: 'error', msg: '未在房间内' });

    if (msg.type === 'start') {
      if (room.hostId !== ws.id) return send({ type: 'error', msg: '只有房主可以开始' });
      const r = room.start();
      if (r.err) return send({ type: 'error', msg: r.err });
      broadcast(room);
      scheduleAI(room);
      return;
    }

    if (msg.type === 'addAI') {
      if (room.hostId !== ws.id) return send({ type: 'error', msg: '只有房主可以加 AI' });
      const r = room.addAI();
      if (r.err) return send({ type: 'error', msg: r.err });
      broadcast(room);
      return;
    }

    if (msg.type === 'removeAI') {
      if (room.hostId !== ws.id) return send({ type: 'error', msg: '只有房主可以移除 AI' });
      const r = room.removeAIAt(msg.seat);
      if (r.err) return send({ type: 'error', msg: r.err });
      broadcast(room);
      return;
    }

    if (msg.type === 'bid') {
      const r = room.submitBid(ws.seat, msg.bid);
      if (r.err) return send({ type: 'error', msg: r.err });
      broadcast(room);
      scheduleAI(room);
      return;
    }

    if (msg.type === 'play') {
      const r = room.playCard(ws.seat, msg.cardIdx);
      if (r.err) return send({ type: 'error', msg: r.err });
      broadcast(room);
      if (r.trickDone) scheduleAdvance(room);
      // AI 循环一直在跑，不用额外调度
      return;
    }

    if (msg.type === 'next') {
      if (room.hostId !== ws.id) return send({ type: 'error', msg: '只有房主可以进入下一轮' });
      const r = room.nextRound();
      if (r.err) return send({ type: 'error', msg: r.err });
      broadcast(room);
      scheduleAI(room);
      return;
    }

    if (msg.type === 'leave') {
      // 用户主动离开：等待房间移除后不再回来
      const room = rooms.get(ws.roomCode);
      if (room) {
        // 从 players 中移除，不管游戏状态
        const idx = room.players.findIndex(p => p.id === ws.id);
        if (idx >= 0) {
          const wasHost = room.hostId === ws.id;
          room.players.splice(idx, 1);
          room.players.forEach((p, i) => p.seat = i);
          if (room.players.length === 0) {
            rooms.delete(ws.roomCode);
          } else {
            if (wasHost) room.hostId = room.players[0].id;
            // 游戏中有人主动离开：为简化，回到 waiting 让房主重开
            if (room.state !== 'waiting') {
              room.state = 'waiting';
              room.round = 0; room.hands = []; room.bids = []; room.wins = [];
              room.scores = room.players.map(() => 0);
              room.currentTrick = [];
            }
            broadcast(room);
          }
        }
      }
      ws.roomCode = null; ws.seat = null;
      send({ type: 'leftOk' });
      return;
    }

    if (msg.type === 'ping') {
      send({ type: 'pong' });
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    room.removePlayer(ws.id);
    // 空房清理
    if (room.players.length === 0) {
      rooms.delete(ws.roomCode);
    } else {
      broadcast(room);
    }
  });
});

// 心跳保活（Render 免费实例 15 分钟无请求会休眠，房间内心跳能拉住）
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.readyState === 1) { try { ws.send('{"type":"heartbeat"}'); } catch(e){} }
  });
}, 25000);

server.listen(PORT, () => {
  console.log(`财神大战 · 服务已启动 http://localhost:${PORT}`);
});
