"""Optional static references, matching scripts/reference-docs.mjs."""
import json
import os
import socket


def reference_dir(name, repo_root, env=None):
    """First readable directory: environment, matching profile, checkout docs."""
    env = os.environ if env is None else env
    roots = []
    if env.get('MMRSIM_REFERENCE_ROOT'):
        roots.append(env['MMRSIM_REFERENCE_ROOT'])
    try:
        profile_path = env.get('MACHINE_PROFILE') or os.path.expanduser('~/.machine/machine.json')
        with open(profile_path, encoding='utf-8') as source:
            profile = json.load(source)
        hostname = profile.get('hostname')
        if isinstance(hostname, str) and hostname and hostname.lower() == socket.gethostname().lower():
            root = profile.get('repos', {}).get('online_open_rocket', {}).get('referenceDocs')
            if isinstance(root, str) and root and os.path.isdir(root):
                roots.append(root)
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    roots.extend([os.path.join(repo_root, 'docs'),
                  os.path.abspath(os.path.join(repo_root, '..', '..', 'online_open_rocket', 'docs'))])
    for root in roots:
        try:
            path = os.path.join(root, name)
            if os.path.isdir(path):
                return path
        except (OSError, ValueError, TypeError):
            pass
    return None
