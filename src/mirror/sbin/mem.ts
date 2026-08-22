import { Program, std } from "@tsix/Application";

export const main = Program (async (args: string[]) => {  
  const memory = process.memoryUsage();   
   std.println(
     `rss: ${(memory.rss / 1024 / 1024).toFixed(2)} MB \n`+
     `heapTotal: ${(memory.heapTotal / 1024 / 1024).toFixed(2)} MB \n`+
     `heapUsed: ${(memory.heapUsed / 1024 / 1024).toFixed(2)} MB \n`+
     `external: ${(memory.external / 1024 / 1024).toFixed(2)} MB \n`+
     `arrayBuffers: ${(memory.arrayBuffers / 1024 / 1024).toFixed(2)} MB \n`
   );
});