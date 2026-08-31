import { MQTNLProtocolBinary } from "./MQTNLProtocolBinary";

/**
 * MQTNLProtocolBinfeo — protokol biner yang BISA DIENKRIPSI, untuk komunikasi
 * normal (BUKAN untuk ESP OTA).
 *
 * Format wire sama dengan MQTNLProtocolBinary (header kompak + payload byte
 * mentah), tapi magic char dan topic prefix dibedakan supaya tidak bentrok
 * dengan jalur OTA:
 *   - getName()        → "Binfeo"
 *   - getMagicChars()  → 0x66 ('f' — "feo", bukan 'B' OTA)
 *   - getTopicPrefix() → "mqtnl@1.2/"
 *
 * Bedanya dengan "Binary" (OTA) ada di driver, bukan di sini: driver memakai
 * protocol ini untuk mengirim payload yang DIENKRIPSI via securePacketOutRaw()
 * (asal ada session key utk srcPort), sedangkan "Binary" (OTA) selalu melewati
 * enkripsi supaya panjang byte persis.
 *
 * (c) 2026 TSIX Project
 */
export class MQTNLProtocolBinfeo extends MQTNLProtocolBinary {
  /** Magic 'f' (feo) — berbeda dari 'B' (0x42) milik protocol OTA. */
  protected magicByte: number = 0x66;
  protected protoVersion: number = 0x01;

  getName(): string {
    return "Binfeo";
  }

  getMagicChars(): number[] {
    return [this.magicByte];
  }

  getTopicPrefix(): string {
    return "mqtnl@1.2/";
  }
}

export default MQTNLProtocolBinfeo;
