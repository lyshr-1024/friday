#!/bin/zsh
# 生成本机自签代码签名证书 "Friday Dev" 并导入登录钥匙串。
# 只需跑一次；中途会弹窗要钥匙串密码。tauri build 用它签名，保证 bundle 身份稳定、TCC 权限不重置。
set -euo pipefail
NAME="Friday Dev"
if security find-identity -v -p codesigning | grep -q "$NAME"; then
  echo "证书 $NAME 已存在"; exit 0
fi
TMP=$(mktemp -d)
cat > "$TMP/ext.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $NAME
[v3]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:false
CNF
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/ext.cnf"
openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -out "$TMP/friday.p12" -passout pass:friday -legacy
security import "$TMP/friday.p12" -k ~/Library/Keychains/login.keychain-db -P friday -T /usr/bin/codesign -T /usr/bin/security
security add-trusted-cert -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db "$TMP/cert.pem"
rm -rf "$TMP"
security find-identity -v -p codesigning | grep "$NAME"
