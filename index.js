const express = require('express');
const { createServer } = require('node:http');
const { join } = require('node:path');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { availableParallelism } = require('node:os');
const cluster = require('node:cluster');
const { createAdapter, setupPrimary } = require('@socket.io/cluster-adapter');

if (cluster.isPrimary) {
  const numCPUs = availableParallelism();
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork({
      PORT: 3000 + i
    });
  }

  return setupPrimary();
}

async function main() {
  const db = await open({
    filename: 'chat.db',
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_offset TEXT UNIQUE,
      content TEXT
    );
  `);

  const nicknames = {}; 
  const app = express();
  const server = createServer(app);
  const io = new Server(server, {
    connectionStateRecovery: {},
    adapter: createAdapter()
  });
  app.get('/', (req, res) => {
    res.sendFile(join(__dirname, 'index.html'));
  });
  let connectedUsers = 0; 
  io.on('connection', async (socket) => {
    connectedUsers++; 
    console.log(`User Connected: ${socket.id}`);
  
    socket.on('set nickname', (nickname, callback) => { 
      if(Object.values(nicknames).includes(nickname)) {
        callback({success: false, message: 'Nickname is already taken.' }); 

      } else { 
        nicknames[socket.id] = nickname; 
        callback({ success: true, message: `Welcome, ${nickname}!`}); 
        
      }
      io.emit('user connected', `A user has connected. Total users: ${connectedUsers}`);
    });

    socket.on('chat message', async (msg, clientOffset, callback) => {
      let result;
      try {
        result = await db.run('INSERT INTO messages (content, client_offset) VALUES (?, ?)', msg, clientOffset);
      } catch (e) {
        if (e.errno === 19 ) {
          callback();
        } else {
          
        }
        return;
      }
      const nickname = nicknames[socket.id] || 'Anonymous'; 
      io.emit('chat message', {message: msg, nickname}, result.lastID);
      callback();
    });

    if (!socket.recovered) {
      try {
        await db.each('SELECT id, content FROM messages WHERE id > ?',
          [socket.handshake.auth.serverOffset || 0],
          (_err, row) => {
            socket.emit('chat message', {message: row.content, nickname: 'Anonymous' }, row.id);
          }
        )
      } catch (e) {
        console.error(e); 
      }
    }

    socket.on('disconnect', () =>{ 
      connectedUsers--; 
      const nickname = nicknames[socket.id] || 'A user'; 
      delete nicknames[socket.id]; 
      console.log(`user disconnected: ${socket.id}`); 
      io.emit('user disconnected', `${nickname} user has disconnected. Total users: ${connectedUsers}`); 
    })
  });

  const port = process.env.PORT;

  server.listen(port, () => {
    console.log(`server running at http://localhost:${port}`);
  });
}

main();