import * as crypto from "crypto";
import { NetSocket, type NetPacket } from "@tsix/Application";
import { SecurityAgent } from "@common/SecurityAgent";
import {
  dashboardClientProof,
  dashboardKeyTag,
  dashboardPsk,
  dashboardServerProof,
  deriveDashboardSessionKey,
  isDashboardNonce,
} from "@tsix/lantana/lantana-dashboard-psk";
import { safeEqualHex } from "@tsix/lantana/lantana-psk";

export type DashboardConnectionPhase =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "authenticated";

export interface DashboardCommunicationCallbacks {
  onStatus: (message: string, color?: string) => void;
  onSecureMessage: (message: unknown) => void;
  onClose: (reason?: string) => void;
}

function packetText(packet: NetPacket): string {
  return Buffer.isBuffer(packet.data)
    ? packet.data.toString("utf8")
    : String(packet.data ?? "");
}

export class DashboardCommunication {
  private socket: NetSocket | null = null;
  private cipher: SecurityAgent | null = null;
  private host = "";
  private port = 0;
  private pinHash = "";
  private clientNonce = "";
  private handshakeTimeout: ReturnType<typeof setTimeout> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  phase: DashboardConnectionPhase = "disconnected";

  constructor(private readonly callbacks: DashboardCommunicationCallbacks) {}

  get isAuthenticated(): boolean {
    return this.phase === "authenticated";
  }

  async connect(host: string, port: number, pin: string): Promise<void> {
    await this.close("Azalea reconnecting");

    if (!host) throw new Error("Alamat node TSIX wajib diisi.");
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Port dashboard tidak valid.");
    }
    if (!/^\d{6}$/.test(pin)) {
      throw new Error("PIN dashboard harus terdiri dari 6 digit.");
    }

    this.host = host;
    this.port = port;
    this.pinHash = crypto.createHash("sha256").update(pin, "utf8").digest("hex");
    this.clientNonce = crypto.randomBytes(16).toString("hex");
    this.phase = "connecting";

    const client = new NetSocket({
      port: 0,
      protocol: "JSON",
      autoCleanup: false,
    });
    this.socket = client;
    client.onData = (packet) =>
      this.handlePacket(packet).catch(async (error) => {
        await this.close("Azalea communication error");
        this.callbacks.onStatus(
          error instanceof Error ? error.message : String(error),
          "#f44336",
        );
      });
    client.onError = (error) =>
      this.callbacks.onStatus(`NetSocket: ${error.message}`, "#f44336");
    client.onClose = (reason) => {
      if (this.socket === client && this.phase !== "disconnected") {
        this.phase = "disconnected";
        this.callbacks.onClose(reason);
      }
    };

    this.callbacks.onStatus(`Membuka NetSocket ke ${host}:${port}ÃÂ¢ÃÂÃÂ¦`);
    try {
      await client.open();
      this.handshakeTimeout = setTimeout(() => {
        void this.close("Dashboard handshake timeout").finally(() => {
          this.callbacks.onStatus("Timeout saat handshake dashboard.", "#f44336");
        });
      }, 10_000);
      await this.sendPlain({
        type: "LANTANA_DASH_HELLO",
        mode: "psk",
        keyTag: dashboardKeyTag(this.pinHash),
        clientNonce: this.clientNonce,
      });
      this.callbacks.onStatus(`Menghubungi ${host}:${port}ÃÂ¢ÃÂÃÂ¦`);
    } catch (error) {
      await this.close("Azalea connection failed");
      throw error;
    }
  }

  async close(reason = "Azalea disconnected"): Promise<void> {
    if (this.handshakeTimeout) clearTimeout(this.handshakeTimeout);
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.handshakeTimeout = null;
    this.keepAliveTimer = null;

    const oldSocket = this.socket;
    this.socket = null;
    this.cipher = null;
    this.phase = "disconnected";
    this.host = "";
    this.port = 0;
    this.pinHash = "";
    this.clientNonce = "";
    if (oldSocket) await oldSocket.close(reason);
  }

  async sendPlain(value: Record<string, unknown>): Promise<void> {
    if (!this.socket?.isOpen) throw new Error("Socket belum terhubung.");
    const sent = await this.socket.sendTo(
      this.host,
      this.port,
      JSON.stringify(value),
    );
    if (!sent) throw new Error("Paket tidak terkirim ke server.");
  }

  async sendEncrypted(value: Record<string, unknown>): Promise<void> {
    if (!this.socket?.isOpen || !this.cipher || this.phase !== "authenticated") {
      throw new Error("Sesi dashboard belum terautentikasi.");
    }
    const sent = await this.socket.sendTo(
      this.host,
      this.port,
      this.cipher.securePacketOut(JSON.stringify(value)),
    );
    if (!sent) throw new Error("Paket terenkripsi tidak terkirim.");
  }

  private async handlePacket(packet: NetPacket): Promise<void> {
    const text = packetText(packet);
    if (!text) return;

    let plainMessage: any = null;
    try {
      plainMessage = JSON.parse(text);
    } catch {
      plainMessage = null;
    }
    if (plainMessage && typeof plainMessage.type === "string") {
      if (plainMessage.type === "LANTANA_DASH_CHALLENGE") {
        if (
          plainMessage.mode !== "psk" ||
          !isDashboardNonce(plainMessage.serverNonce) ||
          typeof plainMessage.serverProof !== "string"
        ) {
          throw new Error("Challenge server tidak valid.");
        }
        const psk = dashboardPsk(this.pinHash);
        const expected = dashboardServerProof(
          psk,
          this.clientNonce,
          plainMessage.serverNonce,
        );
        if (!safeEqualHex(plainMessage.serverProof, expected)) {
          throw new Error("Server gagal membuktikan identitasnya; periksa PIN.");
        }

        this.cipher = new SecurityAgent();
        this.cipher.setSessionKey(
          deriveDashboardSessionKey(psk, this.clientNonce, plainMessage.serverNonce),
        );
        this.phase = "authenticating";
        await this.sendPlain({
          type: "LANTANA_DASH_AUTH",
          mode: "psk",
          proof: dashboardClientProof(
            psk,
            this.clientNonce,
            plainMessage.serverNonce,
          ),
        });
        this.callbacks.onStatus("Mengautentikasi dashboardÃÂ¢ÃÂÃÂ¦");
        return;
      }
      if (
        plainMessage.type === "LANTANA_DASH_NACK" ||
        plainMessage.type === "LANTANA_DASH_AUTH_FAILED"
      ) {
        throw new Error(plainMessage.message || "Autentikasi dashboard ditolak.");
      }
    }

    if (!this.cipher) {
      throw new Error("Server mengirim data sebelum sesi aman siap.");
    }
    const decoded = this.cipher.securePacketIn(text);
    const message = JSON.parse(decoded);
    if (message?.type === "LANTANA_DASH_AUTH_OK") {
      this.phase = "authenticated";
      if (this.handshakeTimeout) clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = null;
      if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = setInterval(() => {
        void this.sendEncrypted({ type: "LANTANA_DASH_KEEPALIVE" }).catch(
          (error) =>
            this.callbacks.onStatus(
              `Keepalive gagal: ${error instanceof Error ? error.message : String(error)}`,
              "#f44336",
            ),
        );
      }, 10 * 60 * 1000);
    }
    this.callbacks.onSecureMessage(message);
  }
}
