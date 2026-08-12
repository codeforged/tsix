// Stub for UserLib (needed by emerald.ts but not used in test harness)
export class UserLib {
  pid = 0;
  getPid() { return 0; }
  getParentPid() { return Promise.resolve(0); }
  onEvent() {}
  std: any = {};
  fs: any = {};
  shell: any = {};
  net: any = {};
}
