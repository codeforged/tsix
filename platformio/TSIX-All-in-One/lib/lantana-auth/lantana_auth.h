#ifndef LANTANA_AUTH_H
#define LANTANA_AUTH_H

#include <tsixlib.h>

class LantanaAuth
{
public:
  LantanaAuth(TSIX &transport, const char *host, int port,
              const char *accountId, const char *deviceId,
              const char *accessKey, const char *fingerprint);

  void begin();
  void loop();
  bool onPlainMessage(const char *json);
  bool onEncryptedMessage(const char *payload);
  bool isOnline() const;
  const char *mode() const;

  /**
   * Laporkan hasil kirim data. Kirim gagal berulang = sesi server kemungkinan
   * hilang, jadi handshake diulang dari awal.
   */
  void noteSendResult(bool ok);

private:
  enum State { IDLE, WAIT_CHALLENGE, WAIT_KEYSET, WAIT_AUTH, ONLINE };

  TSIX &transport_;
  const char *host_;
  int port_;
  const char *accountId_;
  const char *deviceId_;
  const char *accessKey_;
  const char *fingerprint_;
  State state_;
  uint32_t stateStartedAt_;
  uint32_t lastHelloAt_;
  uint32_t onlineSince_;
  bool lastLinkUp_;
  uint8_t sendFailures_;
  uint8_t sessionKey_[TSIX_KEY_SIZE];
  char clientNonceHex_[33];
  char serverNonceHex_[33];

  void restartSession(const char *reason);
  void sendHello();
  void handleChallenge(const char *json);
  void sendAuthEncrypted();
  void fail(const char *message);
};

#endif
