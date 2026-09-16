"""uv 入口：Next.js 前端 + 编译检查"""
import subprocess


def _run(cmd: str):
    """跨平台运行命令"""
    subprocess.run(cmd, shell=True, check=False)


def main():
    """启动开发服务器"""
    _run("npx next dev -p 3000")


def build():
    """生产构建"""
    _run("npx next build")


def start():
    """启动生产服务器"""
    _run("npx next start -p 3000")


def typecheck():
    """TypeScript 类型检查"""
    _run("npx tsc --noEmit")
