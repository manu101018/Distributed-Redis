import * as net from "net";

const PORT = 8000;
const HOST = "0.0.0.0";

const server = net.createServer((connection) => {
    console.log('client conncted');

    connection.on('data', (chunks: Buffer)=>{
        console.log("data received", chunks.toString());
        connection.write(chunks);
    })

    connection.on('close',() =>{
        console.log("client disconnected");
    })

    connection.on('error',(error) =>{
        console.log("client error", error);
    })
})

server.listen(PORT, HOST, ()=>{
    console.log(`Server is running on ${HOST}:${PORT}`);
})