import { strict as assert } from "node:assert";
import { Socket } from "node:net";

import { WebSocket } from "ws";
import { SymmEasyEncrypt } from "../libs/symmetricEnc.mjs";

const decoder = new TextDecoder();

export async function connectForward(refID, tcpLocalPort, tcpLocalIP, serverSocketID, serverIP, serverPort, clientDB) {
  const socketClient = new Socket();
  const ws = new WebSocket(`ws://${serverIP}:${serverPort}`);

  const clientFound = await clientDB.findOne({
    refID
  });

  assert.ok(clientFound, "Somehow the client doesn't exist");

  let isServerConnReady = false;
  let isClientConnReady = false;

  const clientConnBuffer = [];
  const serverConnBuffer = [];

  const encryption = new SymmEasyEncrypt(clientFound.password, "text");
  
  ws.on("open", async() => {
    const encryptedChallenge = await encryption.encrypt("FRESH_TCP_CHALLENGER", "text");
    ws.send(`EXPLAIN_TCP ${refID} ${serverSocketID} ${encryptedChallenge}`);

    ws.on("message", async(data) => {
      let justRecievedPraise = false;
      const dataDecrypted = await encryption.decrypt(data);

      if (!isServerConnReady) {
        const decodedMsg = decoder.decode(dataDecrypted);
        if (decodedMsg == "SUCCESS") isServerConnReady = true;

        justRecievedPraise = true;
        return;
      }
      
      if (isClientConnReady && clientConnBuffer.length != 0) {
        while (clientConnBuffer.length != 0) {
          const item = clientConnBuffer[0];
          socketClient.write(item);

          clientConnBuffer.splice(0, 1);
        }

        assert.equal(clientConnBuffer.length, 0, "Client connection buffer is not empty");
      }

      // FIXME: This should be a daemon.

      if (justRecievedPraise) {
        if (serverConnBuffer.length != 0) {
          while (serverConnBuffer.length != 0) {
            const item = serverConnBuffer[0];
            ws.send(item);
            
            serverConnBuffer.splice(0, 1);
          }

          assert.equal(serverConnBuffer.length, 0, "Server connection buffer is not empty");
        }
      }
      
      if (!isClientConnReady) clientConnBuffer.push(dataDecrypted);
      else socketClient.write(dataDecrypted);
    });
  });

  socketClient.on("connect", () => {
    socketClient.on("data", async(data) => {
      const dataEncrypted = await encryption.encrypt(data);

      if (!isServerConnReady) serverConnBuffer.push(dataEncrypted); 
      else ws.send(dataEncrypted);
    });

    isClientConnReady = true;
    
    while (clientConnBuffer.length != 0) {
      const item = clientConnBuffer[0];
      socketClient.write(item);

      clientConnBuffer.splice(0, 1);
    }

    assert.equal(clientConnBuffer.length, 0, "Client connection buffer is not empty");
  });

  socketClient.on("error", (e) => {
    console.error("An error has occured:", e);
    console.error("Closing current connection...");

    ws.close();
    try {
      socketClient.end();
    } catch (e) {
      console.error("Failed to end connection on socketClient:", e);
    }
  });

  socketClient.on("close", () => {
    if (ws.CLOSED) return;
    ws.close();
  });

  ws.on("close", () => {
    if (socketClient.closed) return;
    socketClient.end();
  });

  socketClient.connect(tcpLocalPort, tcpLocalIP);
}