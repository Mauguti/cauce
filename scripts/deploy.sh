#!/usr/bin/env bash
#
# Despliegue sin desfase de Cauce: orquestador (EC2) y consola (Firebase
# Hosting) con la MISMA versión (commit corto). El orden importa —
# primero el orquestador, que agrega rutas nuevas; luego la consola, que
# las consume— y al final se verifica que /health reporte esa versión.
#
# Uso:
#   scripts/deploy.sh              # despliega HEAD a ambos
#   scripts/deploy.sh --solo-consola
#   scripts/deploy.sh --solo-orquestador
#
# Requiere, en variables de entorno (no en el repo):
#   CAUCE_SSH        usuario@host de la EC2 (p. ej. ubuntu@1.2.3.4)
#   CAUCE_API_URL    URL pública del orquestador (p. ej. https://cauce.digsol.com.mx)
#   FIREBASE_PROJECT proyecto de Hosting (default: cauce-consola)
set -euo pipefail

VERSION="$(git rev-parse --short HEAD)"
API_URL="${CAUCE_API_URL:-https://cauce.digsol.com.mx}"
FIREBASE_PROJECT="${FIREBASE_PROJECT:-cauce-consola}"
MODO="${1:-ambos}"

echo "== Cauce deploy · versión ${VERSION} =="

if [ -n "$(git status --porcelain)" ]; then
  echo "⚠  Hay cambios sin commitear. Commitea antes de desplegar." >&2
  exit 1
fi

desplegar_orquestador() {
  echo "-- Orquestador → ${CAUCE_SSH:?define CAUCE_SSH} --"
  # Pull del commit actual, instala, reinicia el servicio con la versión.
  # CAUCE_VERSION se fija en el entorno del servicio para que /health la exponga.
  ssh "$CAUCE_SSH" bash -se <<REMOTO
    set -euo pipefail
    cd /opt/cauce
    git fetch --quiet origin
    git checkout --quiet ${VERSION}
    npm ci --omit=dev >/dev/null 2>&1 || npm ci >/dev/null
    # Fija la versión en el EnvironmentFile del servicio (idempotente).
    sudo sed -i '/^CAUCE_VERSION=/d' /etc/cauce.env
    echo "CAUCE_VERSION=${VERSION}" | sudo tee -a /etc/cauce.env >/dev/null
    sudo systemctl restart cauce
REMOTO
  echo "   esperando /health…"
  for i in $(seq 1 30); do
    if curl -sf "${API_URL}/health" >/dev/null 2>&1; then break; fi
    sleep 2
  done
}

desplegar_consola() {
  echo "-- Consola → Firebase Hosting (${FIREBASE_PROJECT}) --"
  # La versión compilada debe coincidir con la del orquestador.
  VITE_CAUCE_VERSION="${VERSION}" \
  VITE_CAUCE_API="${API_URL}" \
    npm run build -w @cauce/console
  firebase deploy --only hosting --project "${FIREBASE_PROJECT}"
}

case "$MODO" in
  --solo-consola) desplegar_consola ;;
  --solo-orquestador) desplegar_orquestador ;;
  ambos) desplegar_orquestador; desplegar_consola ;;
  *) echo "modo desconocido: $MODO" >&2; exit 1 ;;
esac

echo "== Verificación final =="
SALUD="$(curl -sf "${API_URL}/health" || true)"
echo "   /health → ${SALUD}"
if echo "$SALUD" | grep -q "\"version\":\"${VERSION}\""; then
  echo "✓ Orquestador en versión ${VERSION}. Consola compilada en ${VERSION}."
  echo "  Coinciden: sin desfase."
else
  echo "✗ /health NO reporta ${VERSION}. Revisa el reinicio del servicio." >&2
  exit 1
fi
