import argparse

from pathlib import Path
from os import system


def upload_to_artifactory(src_path: Path, repository: str, org: str, version: str, pattern = "*"):
    print(f"Uploading {src_path} to {repository} with version {version}")

    for file in src_path.glob(pattern):
        if not file.is_file():
            continue

        sanitized_version = version.replace("/", "_")
        module = file.stem.replace(f"-{sanitized_version}", "")

        dest = f"{repository}/{org}/{module}/{file.name}"
        print(f"Uploading {file} to {dest}")
        system(f'jf rt u "{file}" "{dest}"')


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Upload to Artifactory")
    parser.add_argument("repository", type=str, help="Repository")
    parser.add_argument("org", type=str, help="Organization")
    parser.add_argument("version", type=str, help="Version")
    parser.add_argument("src_path", type=Path, help="Source path")
    parser.add_argument("pattern", type=str, help="Pattern to match files")
    args = parser.parse_args()

    upload_to_artifactory(args.src_path, args.repository, args.org, args.version, args.pattern)
