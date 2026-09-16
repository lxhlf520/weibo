"""uv 入口：评论权限检测"""
import subprocess, sys


def _run(cmd: str):
    subprocess.run(cmd, shell=True, check=False)


def main():
    args = " ".join(sys.argv[1:])
    _run(f"npx tsx src/jobs/checker.ts {args}")
