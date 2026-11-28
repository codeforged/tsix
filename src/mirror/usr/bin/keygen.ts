import { Program, std } from "@tsix/Application";
import { SecurityAgent } from "@common/SecurityAgent";

export default Program(async (args) => {
  // 1. 32 byte acak dari CSPRNG (crypto.randomBytes lewat SecurityAgent).
  //    Dulu Math.random: bukan sumber acak kriptografis, tidak layak untuk kunci.
  const KEY_HEX = SecurityAgent.generateSessionKey().toString("hex");

  // 2. Format untuk firmware — API key ditanam sebagai string hex (ramah dibaca)
  const C_STRING = `char apiKey[] = "${KEY_HEX}";`;

  // Tampilkan hasil ke terminal TSIX via std
  std.println(`const KEY_HEX = "${KEY_HEX}";`);
  std.println(`// === taruh di firmware (main.cpp) ===`);
  std.println(C_STRING);
  std.println(`// === atau untuk netfsd / mount NetFS ===`);
  std.println(`KEY=${KEY_HEX}`);
});
