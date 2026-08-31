import hmac
import os

LOCAL_SERVICE_TOKEN = os.environ.get('WAVEFORGE_LOCAL_TOKEN', '')


def is_authorized_local_request(supplied_token: str = '') -> bool:
    if not LOCAL_SERVICE_TOKEN:
        return True
    return hmac.compare_digest(str(supplied_token or ''), LOCAL_SERVICE_TOKEN)
