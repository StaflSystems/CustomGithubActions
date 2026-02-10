#!/usr/bin/env python3

# This script collects release artifacts in a folder and appends the version to their name.

import os
import sys
from pathlib import Path
from genericpath import exists
from typing import List
from shutil import copyfile


def main(version: str, globbing_patterns: str, destination: str, prefix: str):
    print(os.getcwd())

    sanitized_version = version.replace('/', '_')

    current_dir = Path(".")
    destination_dir = Path(destination)
    destination_dir.mkdir(parents=True, exist_ok=True)

    artifacts: List[Path] = []
    for pattern in globbing_patterns.split(","):
        artifacts.extend([f for f in current_dir.glob(pattern) if f.is_file()])

    for artifact in artifacts:
        print(f"{str(artifact)}")
        
        # Primary naming strategy with prefix
        destination_filename = str(destination_dir /
                                   f"{prefix}{artifact.stem}-{sanitized_version}{artifact.suffix}")
        
        # Collision handling strategy (includes prefix)
        if (exists(destination_filename)):
            # We construct the string and then replace slashes to flatten the path
            flattened_name = f"{artifact.parents[0]}{artifact.stem}-{sanitized_version}{artifact.suffix}".replace('/', '_')
            destination_filename = str(destination_dir / f"{prefix}{flattened_name}")
            
        copyfile(
            str(artifact),
            destination_filename
        )

if __name__ == "__main__":
    if len(sys.argv) != 5:
        sys.exit(
            "Correct usage: script.py <version> <artifact globbing patterns> <destination> <prefix>"
        )

    version = sys.argv[1]
    globbing_patterns = sys.argv[2]
    destination = sys.argv[3]
    prefix = sys.argv[4]

    main(version, globbing_patterns, destination, prefix)
    