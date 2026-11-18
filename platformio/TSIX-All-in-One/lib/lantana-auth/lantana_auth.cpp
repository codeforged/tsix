#include "lantana_auth.h"

#include <stdio.h>
#include <string.h>

#if defined(ESP8266)
#include <bearssl/bearssl_hash.h>
#include <bearssl/bearssl_hmac.h>
#else
#include <mbedtls/md.h>
#include <mbedtls/sha256.h>
#include <mbedtls/rsa.h>
#include <mbedtls/pk.h>
#include <esp_system.h>
#endif

#define HANDSHAKE_TIMEOUT_MS 8000
#define HANDSHAKE_RETRY_MS 15000

static void sha256(const uint8_t *data, size_t len, uint8_t out[32])
{
#if defined(ESP8266)
  br_sha256_context c;
  br_sha256_init(&c);
  br_sha256_update(&c, data, len);
  br_sha256_out(&c, out);
#else
  mbedtls_sha256(data, len, out, 0);
#endif
}

static void hmacSha256(const uint8_t *key, size_t keyLen,
                       const uint8_t *data, size_t len, uint8_t out[32])
{
#if defined(ESP8266)
  br_hmac_key_context kc;
  br_hmac_context hc;
  br_hmac_key_init(&kc, &br_sha256_vtable, key, keyLen);
  br_hmac_init(&hc, &kc, 0);
  br_hmac_update(&hc, data, len);
  br_hmac_out(&hc, out);
#else
  mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), key, keyLen, data, len, out);
#endif
}

static void hkdf32(const uint8_t *ikm, size_t ikmLen,
                   const char *saltText, const char *info, uint8_t out[32])
{
  uint8_t prk[32];
  hmacSha256((const uint8_t *)saltText, strlen(saltText), ikm, ikmLen, prk);

  uint8_t buf[128];
  size_t infoLen = strlen(info);
  if (infoLen + 1 > sizeof(buf)) infoLen = sizeof(buf) - 1;
  memcpy(buf, info, infoLen);
  buf[infoLen] = 0x01;
  hmacSha256(prk, sizeof(prk), buf, infoLen + 1, out);
}

static void hexEncode(const uint8_t *in, size_t len, char *out, size_t cap)
{
  TSIX::bytesToHex(in, len, out, cap);
}

static bool constantTimeEqHex(const char *a, const char *b)
{
  if (!a || !b) return false;
  size_t la = strlen(a), lb = strlen(b);
  if (la != lb) return false;
  uint8_t diff = 0;
  for (size_t i = 0; i < la; i++) diff |= (uint8_t)(a[i] ^ b[i]);
  return diff == 0;
}

static bool jsonGetString(const char *json, const char *key, char *out, size_t cap)
{
  if (!json || !key || !out || cap == 0) return false;
  char pattern[48];
  snprintf(pattern, sizeof(pattern), "\"%s\":\"", key);
  const char *p = strstr(json, pattern);
  if (!p) return false;
  p += strlen(pattern);
  size_t i = 0;
  while (*p && *p != '"' && i + 1 < cap)
  {
    if (*p == '\\' && p[1])
    {
      p++;
      switch (*p)
      {
        case 'n': out[i++] = '\n'; break;
        case 'r': out[i++] = '\r'; break;
        case 't': out[i++] = '\t'; break;
        default:  out[i++] = *p;   break;
      }
      p++;
      continue;
    }
    out[i++] = *p++;
  }
  out[i] = '\0';
  return i > 0;
}

static bool jsonHas(const char *json, const char *needle)
{
  return json && needle && strstr(json, needle) != nullptr;
}

LantanaAuth::LantanaAuth(TSIX &transport, const char *host, int port,
                         const char *accountId, const char *deviceId,
                         const char *accessKey, const char *fingerprint)
    : transport_(transport), host_(host), port_(port), accountId_(accountId),
      deviceId_(deviceId), accessKey_(accessKey), fingerprint_(fingerprint),
      state_(IDLE), stateStartedAt_(0), lastHelloAt_(0)
{
  memset(sessionKey_, 0, sizeof(sessionKey_));
  memset(clientNonceHex_, 0, sizeof(clientNonceHex_));
  memset(serverNonceHex_, 0, sizeof(serverNonceHex_));
}

const char *LantanaAuth::mode() const
{
#if defined(ESP8266)
  return "psk";
#else
  return "rsa";
#endif
}

bool LantanaAuth::isOnline() const
{
  return state_ == ONLINE;
}

void LantanaAuth::begin()
{
  sendHello();
}

void LantanaAuth::loop()
{
  uint32_t now = millis();
  if (state_ != ONLINE && state_ != IDLE &&
      now - stateStartedAt_ > HANDSHAKE_TIMEOUT_MS)
  {
    Serial.println("[HS] timeout — ulangi");
    state_ = IDLE;
  }

  if (state_ == IDLE && transport_.mqttConnected() &&
      (lastHelloAt_ == 0 || now - lastHelloAt_ > HANDSHAKE_RETRY_MS))
    sendHello();
}

void LantanaAuth::sendHello()
{
  uint8_t cnonce[16];
  TSIX::randomBytes(cnonce, sizeof(cnonce));
  hexEncode(cnonce, sizeof(cnonce), clientNonceHex_, sizeof(clientNonceHex_));

  char msg[256];
  snprintf(msg, sizeof(msg),
           "{\"type\":\"LANTANA_HELLO\",\"mode\":\"%s\",\"accountId\":\"%s\",\"deviceId\":\"%s\",\"clientNonce\":\"%s\"}",
           mode(), accountId_, deviceId_, clientNonceHex_);

  state_ = WAIT_CHALLENGE;
  stateStartedAt_ = millis();
  lastHelloAt_ = stateStartedAt_;
  bool ok = transport_.sendPlain(host_, port_, msg);
  Serial.printf("[HS] HELLO (%s) %s\n", mode(), ok ? "sent" : "FAILED");
}

bool LantanaAuth::onPlainMessage(const char *json)
{
  Serial.printf("[RX-plain] %s\n", json ? json : "");
  if (!json) return true;

  if (jsonHas(json, "\"LANTANA_CHALLENGE\""))
  {
    if (state_ == WAIT_CHALLENGE) handleChallenge(json);
    return true;
  }

  if (jsonHas(json, "\"LANTANA_KEYSET_OK\""))
  {
    if (state_ == WAIT_KEYSET) sendAuthEncrypted();
    return true;
  }

  if (jsonHas(json, "\"LANTANA_NACK\""))
  {
    Serial.println("[HS] NACK dari server — ulangi handshake");
    state_ = IDLE;
    return true;
  }

  return false;
}

bool LantanaAuth::onEncryptedMessage(const char *payload)
{
  if (!payload) return false;

  if (jsonHas(payload, "\"LANTANA_AUTH_OK\""))
  {
    state_ = ONLINE;
    Serial.println("[HS] ONLINE — mulai kirim data");
    return true;
  }
  if (jsonHas(payload, "\"LANTANA_NACK\""))
  {
    Serial.printf("[HS] NACK: %s\n", payload);
    state_ = IDLE;
    return true;
  }

  return false;
}

void LantanaAuth::handleChallenge(const char *json)
{
  char nonce[64] = {0};
  if (!jsonGetString(json, "nonce", nonce, sizeof(nonce)) || strlen(nonce) != 32)
  {
    fail("[HS] nonce server tidak valid");
    return;
  }
  memcpy(serverNonceHex_, nonce, sizeof(serverNonceHex_));

  char challengeMode[8] = {0};
  jsonGetString(json, "mode", challengeMode, sizeof(challengeMode));

  if (strcmp(challengeMode, "psk") == 0)
  {
    char serverProof[65] = {0};
    jsonGetString(json, "serverProof", serverProof, sizeof(serverProof));

    uint8_t psk[32];
    sha256((const uint8_t *)accessKey_, strlen(accessKey_), psk);

    char text[160];
    snprintf(text, sizeof(text), "LANTANA-V2-SERVER|%s|%s", clientNonceHex_, serverNonceHex_);
    uint8_t mac[32];
    hmacSha256(psk, sizeof(psk), (const uint8_t *)text, strlen(text), mac);
    char expected[65];
    hexEncode(mac, sizeof(mac), expected, sizeof(expected));

    if (!constantTimeEqHex(serverProof, expected))
    {
      fail("[HS] serverProof TIDAK cocok — batalkan");
      return;
    }

    snprintf(text, sizeof(text), "LANTANA-V2-CLIENT|%s|%s", clientNonceHex_, serverNonceHex_);
    hmacSha256(psk, sizeof(psk), (const uint8_t *)text, strlen(text), mac);
    char proof[65];
    hexEncode(mac, sizeof(mac), proof, sizeof(proof));

    char salt[80];
    snprintf(salt, sizeof(salt), "%s|%s", clientNonceHex_, serverNonceHex_);
    hkdf32(psk, sizeof(psk), salt, "LANTANA-V2-SESSION", sessionKey_);

    char msg[256];
    snprintf(msg, sizeof(msg),
             "{\"type\":\"LANTANA_AUTH\",\"mode\":\"psk\",\"accountId\":\"%s\",\"deviceId\":\"%s\",\"proof\":\"%s\"}",
             accountId_, deviceId_, proof);
    transport_.setSessionKey(sessionKey_);
    state_ = WAIT_AUTH;
    stateStartedAt_ = millis();
    if (transport_.sendPlain(host_, port_, msg))
      Serial.println("[HS] AUTH (psk) terkirim");
    else
      fail("[HS] AUTH (psk) gagal dikirim");
    return;
  }

#if !defined(ESP8266)
  char pem[768] = {0};
  if (!jsonGetString(json, "publicKey", pem, sizeof(pem)))
  {
    fail("[HS] publicKey tidak ada di CHALLENGE");
    return;
  }

  uint8_t digest[32];
  sha256((const uint8_t *)pem, strlen(pem), digest);
  char fp[65];
  hexEncode(digest, sizeof(digest), fp, sizeof(fp));
  for (char *p = fp; *p; p++)
    if (*p >= 'a' && *p <= 'f') *p = (char)(*p - 32);
  if (strlen(fp) > 16) fp[16] = '\0';
  Serial.printf("[HS] fingerprint server: %s\n", fp);
  if (fingerprint_ && strlen(fingerprint_) > 0 &&
      !constantTimeEqHex(fp, fingerprint_))
  {
    fail("[HS] fingerprint tidak cocok dengan pin — batalkan");
    return;
  }

  struct RsaRng
  {
    static int generate(void *, unsigned char *out, size_t len)
    {
      for (size_t i = 0; i < len; i += 4)
      {
        uint32_t r = esp_random();
        size_t n = (len - i < 4) ? (len - i) : 4;
        memcpy(out + i, &r, n);
      }
      return 0;
    }
  };

  mbedtls_pk_context pk;
  mbedtls_pk_init(&pk);
  int rc = mbedtls_pk_parse_public_key(&pk, (const unsigned char *)pem, strlen(pem) + 1);
  if (rc != 0)
  {
    Serial.printf("[HS] parse public key gagal: -0x%04X\n", -rc);
    mbedtls_pk_free(&pk);
    state_ = IDLE;
    return;
  }

  mbedtls_rsa_context *rsa = mbedtls_pk_rsa(pk);
  size_t modLen = mbedtls_rsa_get_len(rsa);
  uint8_t wrapped[512];
  if (modLen == 0 || modLen > sizeof(wrapped))
  {
    mbedtls_pk_free(&pk);
    fail("[HS] panjang RSA tidak valid");
    return;
  }

  TSIX::randomBytes(sessionKey_, sizeof(sessionKey_));
  mbedtls_rsa_set_padding(rsa, MBEDTLS_RSA_PKCS_V21, MBEDTLS_MD_SHA1);
  rc = mbedtls_rsa_rsaes_oaep_encrypt(rsa, RsaRng::generate, nullptr, MBEDTLS_RSA_PUBLIC,
                                      nullptr, 0, sizeof(sessionKey_), sessionKey_, wrapped);
  mbedtls_pk_free(&pk);
  if (rc != 0)
  {
    Serial.printf("[HS] OAEP encrypt gagal: -0x%04X\n", -rc);
    state_ = IDLE;
    return;
  }

  char wrappedHex[1025];
  hexEncode(wrapped, modLen, wrappedHex, sizeof(wrappedHex));
  char msg[1200];
  snprintf(msg, sizeof(msg), "{\"type\":\"LANTANA_KEYSET\",\"encryptedKey\":\"%s\"}", wrappedHex);
  state_ = WAIT_KEYSET;
  stateStartedAt_ = millis();
  if (transport_.sendPlain(host_, port_, msg))
    Serial.println("[HS] KEYSET terkirim");
  else
    fail("[HS] KEYSET gagal dikirim");
#else
  fail("[HS] CHALLENGE RSA tidak didukung board ini");
#endif
}

void LantanaAuth::sendAuthEncrypted()
{
  char auth[512];
  snprintf(auth, sizeof(auth),
           "{\"accountId\":\"%s\",\"deviceId\":\"%s\",\"accessKey\":\"%s\",\"nonce\":\"%s\"}",
           accountId_, deviceId_, accessKey_, serverNonceHex_);

  transport_.setSessionKey(sessionKey_);
  char encrypted[1080];
  if (!transport_.encryptPayloadHex(auth, encrypted, sizeof(encrypted)))
  {
    fail("[HS] enkripsi AUTH gagal");
    return;
  }

  char msg[1200];
  snprintf(msg, sizeof(msg),
           "{\"type\":\"LANTANA_AUTH\",\"payload\":\"%s\"}", encrypted);
  state_ = WAIT_AUTH;
  stateStartedAt_ = millis();
  bool ok = transport_.sendPlain(host_, port_, msg);
  Serial.printf("[HS] AUTH (rsa) %s\n", ok ? "terkirim" : "gagal dikirim");
  if (!ok) state_ = IDLE;
}

void LantanaAuth::fail(const char *message)
{
  Serial.println(message);
  state_ = IDLE;
}
