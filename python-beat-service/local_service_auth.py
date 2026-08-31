import hmac
import os

LOCAL_SERVICE_TOKEN = os.environ.get('WAVEFORGE_LOCAL_TOKEN', '')


def is_authorized_local_request(path: str, supplied_token: str = '') -> bool:
    if path == '/health' or not LOCAL_SERVICE_TOKEN:
        return True
    return hmac.compare_digest(str(supplied_token or ''), LOCAL_SERVICE_TOKEN)
