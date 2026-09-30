# Validator configuration (Phase 9 W2). compose.ledger-nodes.yml copies it over the image's
# /etc/indy/indy_config.py at every start; the image's init_and_run.sh then sets NETWORK_NAME from
# INDY_NETWORK_NAME, so the line below is only a placeholder.
NETWORK_NAME = None

LEDGER_DIR = '/var/lib/indy'
LOG_DIR = '/var/log/indy'
KEYS_DIR = '/var/lib/indy'
GENESIS_DIR = '/var/lib/indy'
BACKUP_DIR = '/var/lib/indy/backup'
PLUGINS_DIR = '/var/lib/indy/plugins'
NODE_INFO_DIR = '/var/lib/indy'

# Logs to stdout as well, so `docker logs` and the host's log rotation see them (info level).
enableStdOutLogging = True
logLevel = 20
