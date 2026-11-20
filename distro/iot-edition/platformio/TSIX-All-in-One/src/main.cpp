/**
 * TSIX-All-in-One — entry point (dispatcher varian).
 *
 * Proyek ini punya 4 varian main yang dipilih lewat build flag:
 *   -DAPP_VARIANT_MINIMUM         → mqtnl minimum-sender
 *   -DAPP_VARIANT_MINIMUM_BINFEO  → mqtnl minimum-binfeo-sender (biner tersandi)
 *   -DAPP_VARIANT_LANTANA         → mqtnl lantana-sender (relay + data sensor Lantana)
 *   -DAPP_VARIANT_OTA             → ota-mqtnl (binary OTA + flash)
 *
 * File varian ada di `src/variants/*.cpp` dan TIDAK dikompilasi terpisah
 * (lihat `build_src_filter` di platformio.ini) — file ini yang meng-`#include`
 * varian terpilih sehingga `setup()`/`loop()` cuma ada satu.
 */
#if defined(APP_VARIANT_MINIMUM)
  #include "variants/minimum.cpp"
#elif defined(APP_VARIANT_MINIMUM_BINFEO)
  #include "variants/minimum-binfeo.cpp"
#elif defined(APP_VARIANT_LANTANA)
  #include "variants/lantana.cpp"
#elif defined(APP_VARIANT_OTA)
  #include "variants/ota.cpp"
#else
  #error "Tentukan salah satu build flag: APP_VARIANT_MINIMUM / APP_VARIANT_MINIMUM_BINFEO / APP_VARIANT_LANTANA / APP_VARIANT_OTA"
#endif
