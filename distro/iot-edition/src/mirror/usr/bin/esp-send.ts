import { Program, std, net } from "@tsix/Application";

export default Program(async (args) => {
    if (args.length < 2) {
        await std.print("Usage: esp-send <mqtnl address> <mqtnl port> <message...>\n");
        await std.print("Example: esp-send OTA-DEVICE hello world\n");
        return;
    }

    const targetHost = args[0];
    const message = args.slice(2).join(" ");
    const targetPort = Number(args[1]);
    const KEY_HEX = "81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619";

    if (Number.isNaN(targetPort)) {
        await std.print("❌ Invalid target port\n");
        return;
    }

    const socketFd = await net.socket();
    if (socketFd < 0) {
        await std.print("❌ Failed to create socket\n");
        return;
    }

    // Listen di port acak (tidak terlalu penting karena kita di sini sebagai client sementara)
    const myPort = 5000 + Math.floor(Math.random() * 1000);
    await net.bind(socketFd, myPort);

    await net.ioctl(socketFd, 0x1001, { port: myPort, sessionKey: KEY_HEX });
    await net.ioctl(socketFd, 0x1001, { port: targetPort, sessionKey: KEY_HEX });

    await std.print(`[TX] Sending to ${targetHost}:${targetPort} => "${message}"\n`);

    const success = await net.sendto(socketFd, targetHost, targetPort, message, 0, myPort);

    if (success) {
        await std.print("✅ Message successfully dispatched to network.\n");
    } else {
        await std.print("⚠️ Failed to send message.\n");
    }
});
