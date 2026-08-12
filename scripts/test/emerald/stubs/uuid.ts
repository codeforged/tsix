// UUID stub for browser build
export const v4 = () => {
  const d = Date.now().toString(36);
  const r = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${d}-${r()}-4${r().slice(1)}-a${r().slice(1)}-${r()}${(Math.floor(Math.random()*0xffff)).toString(16).padStart(4,'0')}`;
};
