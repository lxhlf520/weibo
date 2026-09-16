"""uv 入口：启动定时调度器"""
import subprocess


def _run(cmd: str):
    subprocess.run(cmd, shell=True, check=False)


def main():
    _run("npx tsx src/jobs/scheduler.ts")
