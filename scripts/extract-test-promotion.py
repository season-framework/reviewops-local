#!/usr/bin/env python3
"""Extract one authenticated Actions archive into a new private directory."""
import json
import os
import pathlib
import stat
import sys
import zipfile

archive, destination, encoded_names = sys.argv[1:]
expected = set(json.loads(encoded_names))
root = pathlib.Path(destination)
root.mkdir(mode=0o700, exist_ok=False)
with zipfile.ZipFile(archive) as source:
    entries = source.infolist()
    names = [entry.filename for entry in entries]
    if len(names) != len(set(names)) or set(names) != expected:
        raise ValueError("Producer archive does not contain the exact expected file set")
    total = 0
    for entry in entries:
        mode = entry.external_attr >> 16
        total += entry.file_size
        if (entry.filename != pathlib.PurePosixPath(entry.filename).name or
                entry.is_dir() or entry.flag_bits & 1 or
                stat.S_IFMT(mode) not in (0, stat.S_IFREG) or
                entry.file_size < 1 or entry.file_size > 512 * 1024**2 or
                total > 1100 * 1024**2):
            raise ValueError("Producer archive contains an unsupported entry")
        target = root / entry.filename
        fd = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as output, source.open(entry) as content:
            remaining = entry.file_size
            while remaining:
                chunk = content.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise ValueError("Truncated producer archive")
                output.write(chunk)
                remaining -= len(chunk)
            if content.read(1):
                raise ValueError("Oversized producer archive entry")
