const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

const SAMPLE_TOPICS = [
  { question: "お弁当のおかずで嬉しいのは？", choices: ["唐揚げ", "卵焼き", "ハンバーグ", "エビフライ", "肉じゃが", "ウインナー", "鮭の塩焼き"] },
  { question: "無人島に1つだけ持っていくなら？", choices: ["スマホ", "ナイフ", "テント", "ライター", "釣り竿", "水", "本"] },
  { question: "休日の過ごし方として最高なのは？", choices: ["ゲーム", "映画鑑賞", "昼寝", "旅行", "料理", "読書", "スポーツ"] },
  { question: "ラーメンのトッピングで外せないのは？", choices: ["チャーシュー", "煮卵", "メンマ", "ねぎ", "もやし", "のり", "コーン"] },
  { question: "1億円もらえる代償として許せるのは？", choices: ["1年間口がきけない", "10年間海外で暮らす", "好きな食べ物を一生食べられない", "毎朝4時起き", "SNS禁止", "髪を剃る", "毎日10km走る"] },
  { question: "もし動物に生まれ変わるなら？", choices: ["猫", "犬", "イルカ", "鷹", "ライオン", "パンダ", "ペンギン"] },
  { question: "カラオケで盛り上がる曲ジャンルは？", choices: ["J-POP", "アニソン", "演歌", "洋楽", "ヒップホップ", "昭和歌謡", "ボカロ"] },
  { question: "夕食に毎日食べてもいいものは？", choices: ["寿司", "焼肉", "ラーメン", "カレー", "パスタ", "鍋", "唐揚げ"] },
  { question: "超能力が使えるなら欲しいのは？", choices: ["テレパシー", "瞬間移動", "空を飛ぶ", "時間停止", "透明人間", "未来予知", "怪力"] },
  { question: "SNSで一番使うのは？", choices: ["X(Twitter)", "Instagram", "TikTok", "YouTube", "LINE", "Facebook", "Threads"] },
  { question: "才能をもらえるなら？", choices: ["速く走れる", "一発ギャグ", "酒に酔わない", "人に嫌われない", "見たものを忘れない", "動物と会話", "緊張しない"] },
  { question: "言われたら嬉しい褒め言葉は？", choices: ["頭いいね", "話上手だね", "モテそうだね", "優しいね", "明るいね", "面白いね", "歌上手いね"] },
  { question: "尊敬する人の特徴は？", choices: ["アートの才能がある", "歌がうまい", "運動神経抜群", "論理的思考ができる", "コミュ力が高い", "見た目に気を遣ってる", "お金を稼いでいる"] },
  { question: "腹が立つ瞬間は？", choices: ["レジの順番を抜かされる", "勝手にカバンの中身を見られる", "注文した料理が届いてない", "ファッションをいじられる", "お菓子を許可なく一口食べられる", "3日連続で雨が降っている", "コンビニに食べたいものがない"] }
];

function broadcast(room, message) {
  if (!rooms[room]) return;
  const msg = JSON.stringify(message);
  rooms[room].players.forEach(p => {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  });
}

function getRoomState(room) {
  const r = rooms[room];
  return {
    players: r.players.map(p => ({ id: p.id, name: p.name, score: p.score, isHost: p.isHost })),
    phase: r.phase,
    round: r.round,
    currentTopic: r.currentTopic,
    outerId: r.outerId,
    outerName: r.players.find(p => p.id === r.outerId)?.name || '',
    submissions: r.phase === 'reveal' ? r.submissions : {},
    outerAnswer: r.phase === 'reveal' ? r.outerAnswer : null,
    roundScores: r.roundScores || {}
  };
}

// Heartbeat: 死活監視
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

wss.on('close', () => clearInterval(heartbeatInterval));

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let playerId = null;
  let roomId = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    // クライアントからのping応答
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    if (msg.type === 'create_room') {
      roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
      playerId = 'p_' + Math.random().toString(36).substring(2, 8);
      rooms[roomId] = {
        players: [{ id: playerId, name: msg.name, score: 0, isHost: true, ws }],
        phase: 'lobby', round: 0, outerId: null,
        currentTopic: null, outerAnswer: null, submissions: {}, roundScores: {}
      };
      ws.send(JSON.stringify({ type: 'joined', roomId, playerId, state: getRoomState(roomId) }));
    }

    else if (msg.type === 'join_room') {
      roomId = msg.roomId.toUpperCase();
      if (!rooms[roomId]) { ws.send(JSON.stringify({ type: 'error', message: 'ルームが見つかりません' })); return; }
      if (rooms[roomId].phase !== 'lobby') { ws.send(JSON.stringify({ type: 'error', message: 'ゲームはすでに開始されています' })); return; }
      playerId = 'p_' + Math.random().toString(36).substring(2, 8);
      rooms[roomId].players.push({ id: playerId, name: msg.name, score: 0, isHost: false, ws });
      ws.send(JSON.stringify({ type: 'joined', roomId, playerId, state: getRoomState(roomId) }));
      broadcast(roomId, { type: 'state_update', state: getRoomState(roomId) });
    }

    else if (msg.type === 'start_game') {
      const r = rooms[roomId];
      if (!r) return;
      r.phase = 'topic_select'; r.round = 1; r.outerId = r.players[0].id;
      r.players.forEach(p => p.score = 0);
      broadcast(roomId, { type: 'state_update', state: getRoomState(roomId) });
    }

    else if (msg.type === 'set_topic') {
      const r = rooms[roomId];
      if (!r || r.outerId !== playerId) return;
      r.currentTopic = msg.topic;
      r.phase = 'outer_answer'; r.outerAnswer = null; r.submissions = {}; r.roundScores = {};
      broadcast(roomId, { type: 'state_update', state: getRoomState(roomId) });
    }

    else if (msg.type === 'outer_answer') {
      const r = rooms[roomId];
      if (!r || r.outerId !== playerId) return;
      r.outerAnswer = msg.ranking;
      r.phase = 'guessing';
      broadcast(roomId, { type: 'state_update', state: getRoomState(roomId) });
    }

    else if (msg.type === 'submit_guess') {
      const r = rooms[roomId];
      if (!r || playerId === r.outerId) return;
      r.submissions[playerId] = msg.ranking;
      const guessers = r.players.filter(p => p.id !== r.outerId);
      if (guessers.every(p => r.submissions[p.id])) {
        r.roundScores = {};
        guessers.forEach(p => { r.roundScores[p.id] = calcScore(r.outerAnswer, r.submissions[p.id]); });
        guessers.forEach(p => { p.score += r.roundScores[p.id].total; });
        r.phase = 'reveal';
        broadcast(roomId, { type: 'state_update', state: getRoomState(roomId) });
      } else {
        broadcast(roomId, { type: 'state_update', state: getRoomState(roomId) });
      }
    }

    else if (msg.type === 'next_round') {
      const r = rooms[roomId];
      if (!r) return;
      r.round++;
      const idx = r.players.findIndex(p => p.id === r.outerId);
      r.outerId = r.players[(idx + 1) % r.players.length].id;
      r.phase = 'topic_select'; r.currentTopic = null; r.outerAnswer = null; r.submissions = {}; r.roundScores = {};
      broadcast(roomId, { type: 'state_update', state: getRoomState(roomId) });
    }

    else if (msg.type === 'end_game') {
      const r = rooms[roomId];
      if (!r) return;
      r.phase = 'result';
      broadcast(roomId, { type: 'state_update', state: getRoomState(roomId) });
    }

    else if (msg.type === 'restart') {
      const r = rooms[roomId];
      if (!r) return;
      r.phase = 'lobby'; r.round = 0; r.outerId = null;
      r.currentTopic = null; r.outerAnswer = null; r.submissions = {}; r.roundScores = {};
      r.players.forEach(p => p.score = 0);
      broadcast(roomId, { type: 'state_update', state: getRoomState(roomId) });
    }
  });

  ws.on('close', () => {
    if (roomId && rooms[roomId]) {
      rooms[roomId].players = rooms[roomId].players.filter(p => p.id !== playerId);
      if (rooms[roomId].players.length === 0) {
        delete rooms[roomId];
      } else {
        if (!rooms[roomId].players.find(p => p.isHost)) rooms[roomId].players[0].isHost = true;
        broadcast(roomId, { type: 'state_update', state: getRoomState(roomId) });
      }
    }
  });
});

function calcScore(answer, guess) {
  let tanMatches = [], fukuMatches = [];
  for (let i = 0; i < 3; i++) {
    if (answer[i] === guess[i]) tanMatches.push(i + 1);
    else if (guess.includes(answer[i])) fukuMatches.push(i + 1);
  }
  const tanCount = tanMatches.length, fukuCount = fukuMatches.length;
  let label = '', total = 0;
  if (tanCount === 3)                          { label = 'サンレンタン';     total = 6; }
  else if (tanCount === 2 && fukuCount === 1)  { label = 'ニレンタン＋プク'; total = 4; }
  else if (tanCount === 2 && fukuCount === 0)  { label = 'ニレンタン';       total = 3; }
  else if (tanCount === 1 && fukuCount === 2)  { label = 'タン＋ニプク';     total = 3; }
  else if (tanCount === 1 && fukuCount === 1)  { label = 'タン＋プク';       total = 2; }
  else if (tanCount === 1 && fukuCount === 0)  { label = 'タン';             total = 1; }
  else if (tanCount === 0 && fukuCount === 3)  { label = 'サンレンプク';     total = 4; }
  else if (tanCount === 0 && fukuCount === 2)  { label = 'ニプク';           total = 2; }
  else if (tanCount === 0 && fukuCount === 1)  { label = 'プク';             total = 1; }
  else                                         { label = 'ハズレ';           total = 0; }
  return { tanMatches, fukuMatches, label, total };
}

app.get('/api/topics', (req, res) => res.json(SAMPLE_TOPICS));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`サンレンタンサーバー起動中: http://localhost:${PORT}`));
