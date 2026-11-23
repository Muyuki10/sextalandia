const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 5000,
  pingTimeout: 10000
});

app.use(express.static(path.join(__dirname, 'public')));

// Configurações autoritativas da arena e combate
const TICK_RATE = 60;
const RING_LIMIT = 4.35; // Limite interno das cordas do ringue (9x9m)
const MAX_PLAYERS = 10;

const VALID_CHARACTERS = [
  'macaco',
  'indigena',
  'japones',
  'robo',
  'nerdola',
  'queixo',
  'menino_forte',
  'fantasma'
];

// Atributos balanceados por personagem (velocidade e multiplicador leve)
const CHAR_STATS = {
  macaco:       { speed: 5.6, punchDmg: 12, kickDmg: 22, punchCd: 340, kickCd: 720 },
  indigena:     { speed: 5.3, punchDmg: 13, kickDmg: 24, punchCd: 360, kickCd: 750 },
  japones:      { speed: 5.8, punchDmg: 11, kickDmg: 23, punchCd: 310, kickCd: 680 },
  robo:         { speed: 4.8, punchDmg: 13, kickDmg: 25, punchCd: 390, kickCd: 780, reachBonus: 0.35 },
  nerdola:      { speed: 5.1, punchDmg: 12, kickDmg: 23, punchCd: 350, kickCd: 740 },
  queixo:       { speed: 4.7, punchDmg: 15, kickDmg: 25, punchCd: 410, kickCd: 800 },
  menino_forte: { speed: 4.9, punchDmg: 16, kickDmg: 27, punchCd: 420, kickCd: 820 },
  fantasma:     { speed: 5.4, punchDmg: 13, kickDmg: 23, punchCd: 350, kickCd: 730 }
};

const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    let suffix = '';
    for (let i = 0; i < 4; i++) {
      suffix += chars[Math.floor(Math.random() * chars.length)];
    }
    code = `RING-${suffix}`;
  } while (rooms.has(code));
  return code;
}

function getRoundName(totalRemainingPlayers) {
  if (totalRemainingPlayers <= 2) return 'GRANDE FINAL';
  if (totalRemainingPlayers <= 4) return 'SEMIFINAL';
  if (totalRemainingPlayers <= 8) return 'QUARTAS DE FINAL';
  return 'FASE PRELIMINAR';
}

function sanitizeName(raw) {
  if (typeof raw !== 'string') return 'Lutador';
  const clean = raw.trim().replace(/[<>&"'/]/g, '').slice(0, 14);
  return clean || 'Lutador';
}

function broadcastRoomState(room) {
  const playersList = Array.from(room.players.values()).map((p) => ({
    id: p.id,
    name: p.name,
    character: p.character,
    isHost: p.id === room.hostId,
    eliminated: p.eliminated,
    inMatch: p.inMatch
  }));

  io.to(room.code).emit('room_update', {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    players: playersList,
    tournament: room.tournament
      ? {
          roundNumber: room.tournament.roundNumber,
          roundName: room.tournament.roundName,
          matches: room.tournament.matches,
          champion: room.tournament.champion
        }
      : null
  });
}

function startTournamentRound(room) {
  const alivePlayers = Array.from(room.players.values()).filter((p) => !p.eliminated);

  // Se restou apenas 1 jogador, temos o grande campeão
  if (alivePlayers.length === 1) {
    const champ = alivePlayers[0];
    room.status = 'FINISHED';
    room.tournament.champion = {
      id: champ.id,
      name: champ.name,
      character: champ.character
    };
    io.to(room.code).emit('tournament_finished', {
      champion: room.tournament.champion
    });
    broadcastRoomState(room);
    return;
  }

  if (alivePlayers.length === 0) {
    room.status = 'LOBBY';
    room.tournament = null;
    broadcastRoomState(room);
    return;
  }

  // Embaralha os sobreviventes para montar os confrontos 1v1
  const shuffled = [...alivePlayers].sort(() => Math.random() - 0.5);
  room.tournament.roundNumber += 1;
  room.tournament.roundName = getRoundName(shuffled.length);
  room.tournament.matches = [];
  room.activeFights.clear();

  let matchIndex = 1;
  for (let i = 0; i < shuffled.length; i += 2) {
    const p1 = shuffled[i];
    const p2 = shuffled[i + 1];

    if (!p2) {
      // Número ímpar de jogadores: p1 avança automaticamente (BYE)
      p1.inMatch = false;
      room.tournament.matches.push({
        matchId: `R${room.tournament.roundNumber}-M${matchIndex++}`,
        p1: { id: p1.id, name: p1.name, character: p1.character },
        p2: null,
        winnerId: p1.id,
        status: 'BYE'
      });
    } else {
      const matchId = `R${room.tournament.roundNumber}-M${matchIndex++}`;
      p1.inMatch = true;
      p2.inMatch = true;

      // Posições iniciais nos cantos opostos do ringue
      p1.x = 0;
      p1.z = 2.7;
      p1.rotY = 0; // Olhando para -Z
      p1.hp = 100;
      p1.lastPunch = 0;
      p1.lastKick = 0;

      p2.x = 0;
      p2.z = -2.7;
      p2.rotY = Math.PI; // Olhando para +Z
      p2.hp = 100;
      p2.lastPunch = 0;
      p2.lastKick = 0;

      const matchRecord = {
        matchId,
        p1: { id: p1.id, name: p1.name, character: p1.character },
        p2: { id: p2.id, name: p2.name, character: p2.character },
        winnerId: null,
        status: 'FIGHTING'
      };

      room.tournament.matches.push(matchRecord);
      room.activeFights.set(matchId, {
        matchId,
        roundName: room.tournament.roundName,
        p1Id: p1.id,
        p2Id: p2.id,
        finished: false
      });

      // Notifica ambos os lutadores para entrar no ringue 3D
      io.to(p1.id).emit('match_start', {
        matchId,
        roundName: room.tournament.roundName,
        you: { id: p1.id, name: p1.name, character: p1.character, x: p1.x, z: p1.z, rotY: p1.rotY, hp: 100 },
        opponent: { id: p2.id, name: p2.name, character: p2.character, x: p2.x, z: p2.z, rotY: p2.rotY, hp: 100 }
      });

      io.to(p2.id).emit('match_start', {
        matchId,
        roundName: room.tournament.roundName,
        you: { id: p2.id, name: p2.name, character: p2.character, x: p2.x, z: p2.z, rotY: p2.rotY, hp: 100 },
        opponent: { id: p1.id, name: p1.name, character: p1.character, x: p1.x, z: p1.z, rotY: p1.rotY, hp: 100 }
      });
    }
  }

  broadcastRoomState(room);
}

function resolveFight(room, fight, winnerId, loserId, reason = 'KO') {
  if (!fight || fight.finished) return;
  fight.finished = true;
  room.activeFights.delete(fight.matchId);

  const winner = room.players.get(winnerId);
  const loser = room.players.get(loserId);

  if (winner) {
    winner.inMatch = false;
    winner.hp = 100;
  }
  if (loser) {
    loser.inMatch = false;
    loser.eliminated = true;
  }

  const matchObj = room.tournament?.matches.find((m) => m.matchId === fight.matchId);
  if (matchObj) {
    matchObj.winnerId = winnerId;
    matchObj.status = reason === 'WO' ? 'WO' : 'FINISHED';
  }

  if (winner) {
    io.to(winner.id).emit('match_end', {
      result: 'WIN',
      reason,
      winnerName: winner.name
    });
  }
  if (loser) {
    io.to(loser.id).emit('match_end', {
      result: 'LOSE',
      reason,
      winnerName: winner ? winner.name : 'Adversário'
    });
  }

  broadcastRoomState(room);

  // Se todas as lutas da fase terminaram, inicia a próxima fase após 3.5 segundos
  if (room.activeFights.size === 0 && room.status === 'IN_TOURNAMENT') {
    setTimeout(() => {
      if (rooms.has(room.code) && room.status === 'IN_TOURNAMENT' && room.activeFights.size === 0) {
        startTournamentRound(room);
      }
    }, 3500);
  }
}

io.on('connection', (socket) => {
  // Criar Sala Privada
  socket.on('create_room', ({ name, character }) => {
    const cleanName = sanitizeName(name);
    const charId = VALID_CHARACTERS.includes(character) ? character : 'macaco';
    const code = generateRoomCode();

    const room = {
      code,
      hostId: socket.id,
      status: 'LOBBY',
      players: new Map(),
      tournament: null,
      activeFights: new Map()
    };

    room.players.set(socket.id, {
      id: socket.id,
      name: cleanName,
      character: charId,
      eliminated: false,
      inMatch: false,
      x: 0,
      z: 0,
      rotY: 0,
      hp: 100,
      input: { moveX: 0, moveZ: 0 },
      lastPunch: 0,
      lastKick: 0
    });

    rooms.set(code, room);
    socket.roomCode = code;
    socket.join(code);

    socket.emit('room_joined', { code, playerId: socket.id });
    broadcastRoomState(room);
  });

  // Entrar em Sala Privada existente
  socket.on('join_room', ({ code, name, character }) => {
    const normalizedCode = typeof code === 'string' ? code.trim().toUpperCase() : '';
    const room = rooms.get(normalizedCode);

    if (!room) {
      return socket.emit('error_msg', 'Sala não encontrada. Verifique o código.');
    }
    if (room.status !== 'LOBBY') {
      return socket.emit('error_msg', 'O torneio desta sala já está em andamento.');
    }
    if (room.players.size >= MAX_PLAYERS) {
      return socket.emit('error_msg', 'Sala lotada (máximo de 10 jogadores).');
    }

    const cleanName = sanitizeName(name);
    const charId = VALID_CHARACTERS.includes(character) ? character : 'macaco';

    room.players.set(socket.id, {
      id: socket.id,
      name: cleanName,
      character: charId,
      eliminated: false,
      inMatch: false,
      x: 0,
      z: 0,
      rotY: 0,
      hp: 100,
      input: { moveX: 0, moveZ: 0 },
      lastPunch: 0,
      lastKick: 0
    });

    socket.roomCode = normalizedCode;
    socket.join(normalizedCode);

    socket.emit('room_joined', { code: normalizedCode, playerId: socket.id });
    broadcastRoomState(room);
  });

  // Iniciar Torneio (apenas Anfitrião)
  socket.on('start_tournament', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (room.players.size < 2) {
      return socket.emit('error_msg', 'É necessário pelo menos 2 jogadores para iniciar.');
    }

    room.status = 'IN_TOURNAMENT';
    room.players.forEach((p) => {
      p.eliminated = false;
      p.inMatch = false;
      p.hp = 100;
    });

    room.tournament = {
      roundNumber: 0,
      roundName: '',
      matches: [],
      champion: null
    };

    startTournamentRound(room);
  });

  // Reiniciar para o Lobby após o fim do torneio
  socket.on('reset_lobby', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.hostId !== socket.id) return;

    room.status = 'LOBBY';
    room.tournament = null;
    room.activeFights.clear();
    room.players.forEach((p) => {
      p.eliminated = false;
      p.inMatch = false;
      p.hp = 100;
    });

    broadcastRoomState(room);
  });

  // Receber comandos de movimento e rotação do jogador
  socket.on('player_input', ({ moveX, moveZ, rotY }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.status !== 'IN_TOURNAMENT') return;

    const player = room.players.get(socket.id);
    if (!player || !player.inMatch) return;

    const mx = Number(moveX);
    const mz = Number(moveZ);
    const ry = Number(rotY);

    if (Number.isFinite(mx) && Number.isFinite(mz)) {
      const len = Math.hypot(mx, mz);
      if (len > 1) {
        player.input.moveX = mx / len;
        player.input.moveZ = mz / len;
      } else {
        player.input.moveX = mx;
        player.input.moveZ = mz;
      }
    }
    if (Number.isFinite(ry)) {
      player.rotY = ry;
    }
  });

  // Processar ataque autoritativo (Soco ou Chute)
  socket.on('player_attack', ({ type }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.status !== 'IN_TOURNAMENT') return;

    const attacker = room.players.get(socket.id);
    if (!attacker || !attacker.inMatch) return;

    // Encontra a luta ativa do atacante
    let currentFight = null;
    for (const fight of room.activeFights.values()) {
      if (fight.p1Id === attacker.id || fight.p2Id === attacker.id) {
        currentFight = fight;
        break;
      }
    }
    if (!currentFight || currentFight.finished) return;

    const opponentId = currentFight.p1Id === attacker.id ? currentFight.p2Id : currentFight.p1Id;
    const defender = room.players.get(opponentId);
    if (!defender) return;

    const now = Date.now();
    const stats = CHAR_STATS[attacker.character] || CHAR_STATS.macaco;
    const isKick = type === 'kick';

    // Validação de cooldown no servidor (anti-trapaça)
    if (isKick) {
      if (now - attacker.lastKick < stats.kickCd) return;
      attacker.lastKick = now;
    } else {
      if (now - attacker.lastPunch < stats.punchCd) return;
      attacker.lastPunch = now;
    }

    // Notifica ambos os jogadores da animação de ataque
    const attackPayload = {
      attackerId: attacker.id,
      type: isKick ? 'kick' : 'punch'
    };
    io.to(attacker.id).emit('combat_attack', attackPayload);
    io.to(defender.id).emit('combat_attack', attackPayload);

    // Cálculo autoritativo de alcance e ângulo frontal (Hitbox)
    const reach = (isKick ? 2.15 : 1.55) + (stats.reachBonus || 0);
    const dx = defender.x - attacker.x;
    const dz = defender.z - attacker.z;
    const dist = Math.hypot(dx, dz);

    if (dist <= reach) {
      // Vetor frontal do atacante (Three.js: rotY=0 aponta para -Z)
      const fwdX = -Math.sin(attacker.rotY);
      const fwdZ = -Math.cos(attacker.rotY);
      const dirX = dist > 0.001 ? dx / dist : fwdX;
      const dirZ = dist > 0.001 ? dz / dist : fwdZ;
      const dot = fwdX * dirX + fwdZ * dirZ;

      // Cone de acerto (~65 graus para cada lado)
      if (dot >= 0.42) {
        const damage = isKick ? stats.kickDmg : stats.punchDmg;
        defender.hp = Math.max(0, defender.hp - damage);

        // Empurrão (Knockback) respeitando as cordas do ringue
        const knockback = isKick ? 0.65 : 0.32;
        defender.x = Math.max(-RING_LIMIT, Math.min(RING_LIMIT, defender.x + dirX * knockback));
        defender.z = Math.max(-RING_LIMIT, Math.min(RING_LIMIT, defender.z + dirZ * knockback));

        const hitPayload = {
          attackerId: attacker.id,
          defenderId: defender.id,
          damage,
          type: isKick ? 'kick' : 'punch',
          defenderHp: defender.hp
        };
        io.to(attacker.id).emit('combat_hit', hitPayload);
        io.to(defender.id).emit('combat_hit', hitPayload);

        if (defender.hp <= 0) {
          resolveFight(room, currentFight, attacker.id, defender.id, 'KO');
        }
      }
    }
  });

  // Tratamento de desconexão (Vitória por W.O. se estiver no meio da luta)
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms.has(code)) return;

    const room = rooms.get(code);
    const leavingPlayer = room.players.get(socket.id);
    if (!leavingPlayer) return;

    // Verifica se o jogador estava em uma luta ativa
    let activeFight = null;
    for (const fight of room.activeFights.values()) {
      if (fight.p1Id === socket.id || fight.p2Id === socket.id) {
        activeFight = fight;
        break;
      }
    }

    room.players.delete(socket.id);

    if (room.players.size === 0) {
      rooms.delete(code);
      return;
    }

    // Transfere liderança caso o anfitrião saia
    if (room.hostId === socket.id) {
      const nextHost = room.players.keys().next().value;
      room.hostId = nextHost;
    }

    if (activeFight && !activeFight.finished) {
      const winnerId = activeFight.p1Id === socket.id ? activeFight.p2Id : activeFight.p1Id;
      resolveFight(room, activeFight, winnerId, socket.id, 'WO');
    } else {
      // Se estava no torneio aguardando ou era BYE, verifica se sobrou apenas 1 campeão
      if (room.status === 'IN_TOURNAMENT' && room.activeFights.size === 0) {
        startTournamentRound(room);
      } else {
        broadcastRoomState(room);
      }
    }
  });
});

// Loop físico autoritativo a 60Hz
setInterval(() => {
  const dt = 1 / TICK_RATE;

  rooms.forEach((room) => {
    if (room.status !== 'IN_TOURNAMENT' || room.activeFights.size === 0) return;

    room.activeFights.forEach((fight) => {
      if (fight.finished) return;
      const p1 = room.players.get(fight.p1Id);
      const p2 = room.players.get(fight.p2Id);
      if (!p1 || !p2) return;

      [p1, p2].forEach((p) => {
        const stats = CHAR_STATS[p.character] || CHAR_STATS.macaco;
        const speed = stats.speed;

        // Movimento relativo à direção que o lutador está olhando
        const fwdX = -Math.sin(p.rotY);
        const fwdZ = -Math.cos(p.rotY);
        const rightX = Math.cos(p.rotY);
        const rightZ = -Math.sin(p.rotY);

        // moveZ negativo = frente, moveX positivo = direita
        const forwardAmount = -p.input.moveZ;
        const strafeAmount = p.input.moveX;

        const vx = (fwdX * forwardAmount + rightX * strafeAmount) * speed;
        const vz = (fwdZ * forwardAmount + rightZ * strafeAmount) * speed;

        p.x = Math.max(-RING_LIMIT, Math.min(RING_LIMIT, p.x + vx * dt));
        p.z = Math.max(-RING_LIMIT, Math.min(RING_LIMIT, p.z + vz * dt));
      });

      // Colisão suave entre os corpos dos dois lutadores para não atravessarem um ao outro
      const dx = p2.x - p1.x;
      const dz = p2.z - p1.z;
      const dist = Math.hypot(dx, dz);
      const minDist = 0.85;
      if (dist < minDist && dist > 0.0001) {
        const overlap = (minDist - dist) * 0.5;
        const nx = dx / dist;
        const nz = dz / dist;
        p1.x = Math.max(-RING_LIMIT, Math.min(RING_LIMIT, p1.x - nx * overlap));
        p1.z = Math.max(-RING_LIMIT, Math.min(RING_LIMIT, p1.z - nz * overlap));
        p2.x = Math.max(-RING_LIMIT, Math.min(RING_LIMIT, p2.x + nx * overlap));
        p2.z = Math.max(-RING_LIMIT, Math.min(RING_LIMIT, p2.z + nz * overlap));
      }

      // Envia snapshot de sincronização para os dois lutadores
      io.to(p1.id).emit('fight_state', {
        you: { x: p1.x, z: p1.z, rotY: p1.rotY, hp: p1.hp },
        opponent: { x: p2.x, z: p2.z, rotY: p2.rotY, hp: p2.hp }
      });
      io.to(p2.id).emit('fight_state', {
        you: { x: p2.x, z: p2.z, rotY: p2.rotY, hp: p2.hp },
        opponent: { x: p1.x, z: p1.z, rotY: p1.rotY, hp: p1.hp }
      });
    });
  });
}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor RING BRAWL 3D rodando na porta ${PORT}`);
});