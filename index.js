const net = require('net');
const Parser = require('redis-parser');

const dataStore = {};

const server = net.createServer((connection) => {
    connection.on('data', (data) => {
        const parser = new Parser({
            returnReply: (reply) => {
                const command = reply[0];
                const key = reply[1];

                switch (command) {
                    case 'set':
                        const value = reply[2];
                        dataStore[key] = value;
                        connection.write("+OK\r\n");
                        break;
                    case 'get':
                        const result = dataStore[key];
                        if (!result) {
                            connection.write("$-1\r\n");
                        } else {
                            connection.write(`$${result.length}\r\n${result}\r\n`);
                        }
                        break;
                    default:
                        connection.write("$-1\r\n");
                        break;
                }
            },
            returnError: (error) => {
                console.error(error, "error");
                connection.write(`-${error}\r\n`);
            }
        });

        parser.execute(data);
    })
})

server.listen(8000, () => console.log('server started on port 8000'));