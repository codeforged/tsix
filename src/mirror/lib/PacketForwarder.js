var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var stdin_exports = {};
__export(stdin_exports, {
  PacketForwarder: () => PacketForwarder
});
module.exports = __toCommonJS(stdin_exports);
var mqtt = __toESM(require("mqtt"));
const MQTNL_TOPICS = ["mqtnl@1.0/#", "mqtnl@1.1/#", "mqtnl@1.2/#"];
const MAX_FORWARD = 3;
class PacketForwarder {
  clientA = null;
  clientB = null;
  topics = MQTNL_TOPICS;
  isRunning = false;
  // Config
  brokerAUrl;
  brokerBUrl;
  // Stats
  packetsAtoB = 0;
  packetsBtoA = 0;
  bytesAtoB = 0;
  bytesBtoA = 0;
  startTime = 0;
  constructor(brokerA, brokerB) {
    this.brokerAUrl = this.ensureMqttProtocol(brokerA);
    this.brokerBUrl = this.ensureMqttProtocol(brokerB);
  }
  ensureMqttProtocol(url) {
    if (!url.startsWith("mqtt://") && !url.startsWith("ws://") && !url.startsWith("wss://")) {
      return `mqtt://${url}`;
    }
    return url;
  }
  /**
   * startForward(): Connect to both brokers and start mirroring
   */
  async startForward() {
    if (this.isRunning) return false;
    try {
      this.clientA = mqtt.connect(this.brokerAUrl);
      this.clientB = mqtt.connect(this.brokerBUrl);
      this.startTime = Date.now();
      this.clientA.on("connect", () => {
        console.log(`[PacketForwarder] Connected to Broker A: ${this.brokerAUrl}`);
        this.subscribeAll(this.clientA);
      });
      this.clientA.on("message", (topic, message) => {
        this.bridge(message, topic, this.clientB, "A->B");
      });
      this.clientB.on("connect", () => {
        console.log(`[PacketForwarder] Connected to Broker B: ${this.brokerBUrl}`);
        this.subscribeAll(this.clientB);
      });
      this.clientB.on("message", (topic, message) => {
        this.bridge(message, topic, this.clientA, "B->A");
      });
      this.clientA.on("error", (e) => console.error(`[Broker A] Error: ${e.message}`));
      this.clientB.on("error", (e) => console.error(`[Broker B] Error: ${e.message}`));
      this.isRunning = true;
      return true;
    } catch (e) {
      console.error(`[PacketForwarder] Start failed: ${e.message}`);
      return false;
    }
  }
  /**
   * bridge(): Forward packets from one broker to another.
   * Payload diteruskan byte-exact (tanpa re-encode) — hanya counter
   * `forwarded` di header yang di-increment untuk loop prevention.
   */
  bridge(message, topic, targetClient, direction) {
    if (!targetClient || !targetClient.connected) return;
    const next = this.nextHop(message, topic);
    if (!next) return;
    targetClient.publish(topic, next, (err) => {
      if (!err) {
        if (direction === "A->B") {
          this.packetsAtoB++;
          this.bytesAtoB += next.length;
        } else {
          this.packetsBtoA++;
          this.bytesBtoA += next.length;
        }
        const total = this.packetsAtoB + this.packetsBtoA;
        if (total % 100 === 0) {
          console.log(`[PacketForwarder] Bridged: A->B: ${this.packetsAtoB} pkts, B->A: ${this.packetsBtoA} pkts`);
        }
      }
    });
  }
  /** Subscribe ke semua prefix protokol MQTNL. */
  subscribeAll(client) {
    for (const t of this.topics) {
      client?.subscribe(t);
    }
  }
  /**
   * nextHop(): validasi protokol + increment counter `forwarded` (loop prevention),
   * mengembalikan Buffer siap-teruskan, atau null bila paket di-drop.
   * Bekerja di level byte → payload biner/terenkripsi (OTA/Binfeo) tetap utuh.
   */
  nextHop(message, topic) {
    if (topic.startsWith("mqtnl@1.0/")) {
      try {
        const arr = JSON.parse(message.toString("utf8"));
        const fwd = arr[8] || 0;
        if (fwd >= MAX_FORWARD) return null;
        arr[8] = fwd + 1;
        return Buffer.from(JSON.stringify(arr), "utf8");
      } catch {
        return null;
      }
    }
    const magic = message[0];
    if ((magic === 66 || magic === 102) && message[1] === 1 && message.length >= 6) {
      const srcLen = message[2];
      const dstLenPos = 5 + srcLen;
      if (dstLenPos >= message.length) return null;
      const dstLen = message[dstLenPos];
      const fwdPos = 17 + srcLen + dstLen;
      if (fwdPos >= message.length) return null;
      const fwd = message[fwdPos];
      if (fwd >= MAX_FORWARD) return null;
      const out = Buffer.from(message);
      out[fwdPos] = fwd + 1;
      return out;
    }
    return null;
  }
  /**
   * stopForward(): Disconnect from both brokers
   */
  async stopForward() {
    if (!this.isRunning) return false;
    try {
      if (this.clientA) await new Promise((r) => this.clientA.end(false, () => r()));
      if (this.clientB) await new Promise((r) => this.clientB.end(false, () => r()));
      this.isRunning = false;
      console.log(`[PacketForwarder] Bridge stopped. Stats: A->B: ${this.packetsAtoB}, B->A: ${this.packetsBtoA}`);
      return true;
    } catch (e) {
      console.error(`[PacketForwarder] Stop failed: ${e.message}`);
      return false;
    }
  }
  getStats() {
    return {
      brokerA: this.brokerAUrl,
      brokerB: this.brokerBUrl,
      isRunning: this.isRunning,
      packetsAtoB: this.packetsAtoB,
      packetsBtoA: this.packetsBtoA,
      bytesAtoB: this.bytesAtoB,
      bytesBtoA: this.bytesBtoA,
      uptime: this.isRunning ? Date.now() - this.startTime : 0
    };
  }
}
