const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function broadcast(roomId, data) {
  const room = rooms[roomId];
  if (!room) return;
  const msg = JSON.stringify(data);
  room.clients.forEach(client => {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(msg);
  });
}

function sendTo(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function getRoomState(roomId) {
  const room = rooms[roomId];
  if (!room) return null;
  const onlineNames = new Set(room.clients.filter(c => c.ws.readyState === WebSocket.OPEN).map(c => c.name));
  return {
    type: 'state',
    phase: room.phase,
    players: room.players.map(p => ({
      name: p.name,
      money: p.money,
      avatar: p.avatar,
      color: p.color,
      cardCount: p.hand ? p.hand.filter((_, i) => !p.usedCards.includes(i)).length : 0,
      isHost: p.isHost,
      online: onlineNames.has(p.name),
      handSubmitted: p.hand && p.hand.length > 0,
    })),
    currentRound: room.currentRound,
    totalRounds: room.totalRounds,
    currentTheme: room.currentTheme,
    prizePool: room.prizePool,
    currentPlayerIndex: room.currentPlayerIndex,
    turnOrder: room.turnOrder,
    handInputIndex: room.handInputIndex,
    lastResult: room.lastResult,
    submittedCount: room.players.filter(p => p.hand && p.hand.length > 0).length,
    totalCount: room.players.length,
  };
}

const AVATARS = ['🔥','💧','🌿','⚡','🌙','🌟','🐉','👻','🌊','🍃'];
const COLORS = ['#E3350D','#3B82F6','#22C55E','#EAB308','#8B5CF6','#EC4899','#F97316','#6366F1','#06B6D4','#10B981'];

wss.on('connection', (ws) => {
  let playerRoomId = null;
  let playerName = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create_room') {
      const roomId = Math.random().toString(36).substr(2, 5).toUpperCase();
      rooms[roomId] = {
        phase: 'lobby', players: [], currentRound: 1, totalRounds: 4,
        currentTheme: '', prizePool: 0, currentPlayerIndex: 0,
        turnOrder: [], handInputIndex: 0, lastResult: null, clients: [],
      };
      playerRoomId = roomId;
      playerName = msg.name;
      rooms[roomId].players.push({ name: msg.name, money: 150, avatar: AVATARS[0], color: COLORS[0], isHost: true, hand: [], usedCards: [], ws });
      rooms[roomId].clients.push({ name: msg.name, ws });
      sendTo(ws, { type: 'room_created', roomId });
      broadcast(roomId, getRoomState(roomId));
    }

    else if (msg.type === 'join_room') {
      const roomId = msg.roomId.toUpperCase();
      const room = rooms[roomId];
      if (!room) { sendTo(ws, { type: 'error', message: 'ルームが見つかりません' }); return; }

      // 再接続チェック
      const existing = room.players.find(p => p.name === msg.name);
      if (existing) {
        if (existing.disconnectTimer) { clearTimeout(existing.disconnectTimer); existing.disconnectTimer = null; }
        existing.ws = ws;
        playerRoomId = roomId;
        playerName = msg.name;
        const clientEntry = room.clients.find(c => c.name === msg.name);
        if (clientEntry) clientEntry.ws = ws;
        else room.clients.push({ name: msg.name, ws });
        sendTo(ws, { type: 'rejoined', roomId });
        sendTo(ws, { type: 'restore_hand', hand: existing.hand, usedCards: existing.usedCards });
        if (room.phase === 'hand_input') {
          sendTo(ws, { type: 'your_turn_input', theme: room.currentTheme });
        }
        broadcast(roomId, getRoomState(roomId));
        return;
      }

      if (room.phase !== 'lobby') { sendTo(ws, { type: 'error', message: 'ゲームはすでに始まっています' }); return; }
      if (room.players.length >= 6) { sendTo(ws, { type: 'error', message: 'プレイヤーが満員です' }); return; }

      playerRoomId = roomId;
      playerName = msg.name;
      const idx = room.players.length;
      room.players.push({ name: msg.name, money: 150, avatar: AVATARS[idx % AVATARS.length], color: COLORS[idx % COLORS.length], isHost: false, hand: [], usedCards: [], ws });
      room.clients.push({ name: msg.name, ws });
      sendTo(ws, { type: 'joined', roomId });
      broadcast(roomId, getRoomState(roomId));
    }

    else if (msg.type === 'start_game') {
      const room = rooms[playerRoomId];
      if (!room) return;
      const host = room.players.find(p => p.name === playerName);
      if (!host?.isHost) return;
      if (room.players.length < 2) { sendTo(ws, { type: 'error', message: '2人以上必要です' }); return; }
      room.phase = 'theme_select';
      room.currentRound = 1;
      room.prizePool = 0;
      room.turnOrder = room.players.map(p => p.name);
      room.currentPlayerIndex = 0;
      room.players.forEach(p => { p.money = 150; p.hand = []; p.usedCards = []; });
      broadcast(playerRoomId, getRoomState(playerRoomId));
    }

    else if (msg.type === 'select_theme') {
      const room = rooms[playerRoomId];
      if (!room) return;
      const host = room.players.find(p => p.name === playerName);
      if (!host?.isHost) return;
      room.currentTheme = msg.theme;
      room.phase = 'hand_input';
      room.handInputIndex = 0;
      // 全員の手札をリセット
      room.players.forEach(p => { p.hand = []; p.usedCards = []; });
      // 全員に一斉入力要求
      room.players.forEach(p => {
        sendTo(p.ws, { type: 'your_turn_input', theme: room.currentTheme });
      });
      broadcast(playerRoomId, getRoomState(playerRoomId));
    }

    else if (msg.type === 'submit_hand') {
      const room = rooms[playerRoomId];
      if (!room) return;
      const player = room.players.find(p => p.name === playerName);
      if (!player) return;
      player.hand = msg.cards;
      player.usedCards = [];
      // 全員提出済みか確認
      const allSubmitted = room.players.every(p => p.hand && p.hand.length > 0);
      if (allSubmitted) {
        room.phase = 'play';
        room.currentPlayerIndex = 0;
      }
      broadcast(playerRoomId, getRoomState(playerRoomId));
    }

    else if (msg.type === 'play_card') {
      const room = rooms[playerRoomId];
      if (!room) return;
      const currentName = room.turnOrder[room.currentPlayerIndex];
      if (playerName !== currentName) return;
      const player = room.players.find(p => p.name === playerName);
      const cardIndex = msg.cardIndex;
      const cardValue = player.hand[cardIndex].trim().toLowerCase().replace(/[　\s]/g, '');
      player.usedCards.push(cardIndex);

      let matchCount = 0;
      const matchedPlayers = [];
      room.players.forEach(op => {
        if (op.name === playerName) return;
        for (let gi = 0; gi < op.hand.length; gi++) {
          if (!op.usedCards.includes(gi) && op.hand[gi].trim().toLowerCase().replace(/[　\s]/g, '') === cardValue) {
            matchCount++;
            matchedPlayers.push(op.name);
            op.usedCards.push(gi);
            break;
          }
        }
      });

      let prizeChange = 0;
      if (matchCount > 0) {
        prizeChange = matchCount * 10 + room.prizePool;
        player.money += prizeChange;
        room.prizePool = 0;
      } else {
        prizeChange = -10;
        player.money -= 10;
        room.prizePool += 10;
      }

      room.lastResult = { playerName, cardValue: player.hand[cardIndex], matchCount, matchedPlayers, prizeChange, prizePool: room.prizePool };

      const roundOver = room.players.some(p => p.hand.filter((_, i) => !p.usedCards.includes(i)).length === 0);
      room.phase = roundOver ? 'round_end' : 'result';
      broadcast(playerRoomId, getRoomState(playerRoomId));
    }

    else if (msg.type === 'next_turn') {
      const room = rooms[playerRoomId];
      if (!room) return;
      if (!room.players.find(p => p.name === playerName)?.isHost) return;
      room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
      room.phase = 'play';
      room.lastResult = null;
      broadcast(playerRoomId, getRoomState(playerRoomId));
    }

    else if (msg.type === 'next_round') {
      const room = rooms[playerRoomId];
      if (!room) return;
      if (!room.players.find(p => p.name === playerName)?.isHost) return;
      if (room.currentRound >= room.totalRounds) {
        room.phase = 'game_end';
      } else {
        room.currentRound++;
        room.currentPlayerIndex = room.currentRound % room.players.length;
        room.turnOrder = [
          ...room.players.slice(room.currentPlayerIndex).map(p => p.name),
          ...room.players.slice(0, room.currentPlayerIndex).map(p => p.name),
        ];
        room.currentPlayerIndex = 0;
        room.phase = 'theme_select';
        room.lastResult = null;
      }
      broadcast(playerRoomId, getRoomState(playerRoomId));
    }
  });

  ws.on('close', () => {
    if (!playerRoomId || !playerName) return;
    const room = rooms[playerRoomId];
    if (!room) return;
    room.clients = room.clients.filter(c => c.name !== playerName);
    // オンライン状態更新をブロードキャスト
    broadcast(playerRoomId, getRoomState(playerRoomId));
    const player = room.players.find(p => p.name === playerName);
    if (!player) return;
    player.disconnectTimer = setTimeout(() => {
      const r = rooms[playerRoomId];
      if (!r) return;
      if (player.isHost) {
        const next = r.players.find(p => p.name !== playerName);
        if (next) next.isHost = true;
      }
      r.players = r.players.filter(p => p.name !== playerName);
      if (r.players.length === 0) { delete rooms[playerRoomId]; return; }
      broadcast(playerRoomId, getRoomState(playerRoomId));
    }, 30000);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
