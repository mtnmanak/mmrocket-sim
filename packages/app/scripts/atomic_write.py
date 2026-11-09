"""Write generated reference data without truncating the previous artifact."""
import os
import stat
import tempfile


def atomic_write(path, text):
    fd, temporary = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)), suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write(text)
        try:
            mode = stat.S_IMODE(os.stat(path).st_mode)
        except FileNotFoundError:
            mask = os.umask(0)
            os.umask(mask)
            mode = 0o666 & ~mask
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
