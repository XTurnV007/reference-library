"""Publish code, original images (Releases), and a static gallery (GitHub Pages)."""
from __future__ import annotations
import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from build_static import BASE, build
from library import DEFAULT_DATA, crawl_lock, file_hash

SOURCE_FILES = ['.gitignore','README.md','PUBLISH.md','crawler.py','library.py','server.py',
                'verify.py','test_library.py','build_static.py','publish_github.py',
                'static/index.html','static/style.css','static/app.js','web/static-api.js',
                'static/analytics.js','static/analytics.css','analytics.py','analytics_server.py','test_analytics.py','ANALYTICS.md']


def command(args, cwd=BASE, check=True):
    result=subprocess.run(args,cwd=cwd,text=True,encoding='utf-8',errors='replace',capture_output=True)
    if check and result.returncode:
        raise RuntimeError(f'命令失败：{args[0]} {args[1]}\n{result.stderr or result.stdout}')
    return result


def gh_json(*args):
    return json.loads(command(['gh',*args]).stdout)


def source_push(repo, account):
    git_dir=BASE/'.git'
    if git_dir.exists():
        top=Path(command(['git','rev-parse','--show-toplevel']).stdout.strip()).resolve()
        if top!=BASE:raise ValueError('当前目录不是独立仓库，停止发布')
        remote=command(['git','remote','get-url','origin']).stdout.strip()
        accepted={f'https://github.com/{repo}.git',f'https://github.com/{repo}',f'git@github.com:{repo}.git'}
        if remote not in accepted:raise ValueError('已有 origin 与目标仓库不同，停止发布')
        staged=command(['git','diff','--cached','--name-only']).stdout.splitlines()
        if any(name not in SOURCE_FILES for name in staged):raise ValueError('暂存区有本项目发布清单之外的文件，请先自行处理')
    else:
        parent=command(['git','rev-parse','--show-toplevel'],check=False)
        if parent.returncode==0:raise ValueError('项目位于另一个 Git 仓库内，停止初始化，请先复制到独立目录')
        existing=command(['gh','repo','view',repo,'--json','name'],check=False)
        if existing.returncode==0:
            # A new empty repo is fine. A populated unrelated repo is never overwritten.
            refs=gh_json('api',f'repos/{repo}')
            if refs.get('size',0)>0:raise ValueError('目标仓库已有内容，请使用新空仓库或本项目原仓库')
        else:
            command(['gh','repo','create',repo,'--public','--description','Authorized pose and costume reference gallery; Python crawler and static browser'])
        command(['git','init','-b','main'])
        command(['git','remote','add','origin',f'https://github.com/{repo}.git'])
    command(['git','config','user.name',account['login']])
    command(['git','config','user.email',f"{account['id']}+{account['login']}@users.noreply.github.com"])
    command(['git','add','--',*SOURCE_FILES])
    dirty=command(['git','diff','--cached','--quiet'],check=False)
    if dirty.returncode==1:command(['git','commit','-m','Publish reference library source and static gallery tools'])
    elif dirty.returncode!=0:raise RuntimeError(dirty.stderr)
    command(['git','push','-u','origin','HEAD:main'])


def originals_upload(repo, originals):
    groups={}
    for asset in originals:
        if asset.get('storage','release')=='release':groups.setdefault(asset['tag'],[]).append(asset)
    for tag, assets in sorted(groups.items()):
        if len(assets)>1000:raise ValueError('单组原图超过 Releases 的 1000 文件限制，请增加分组位数')
        response=command(['gh','api',f'repos/{repo}/releases/tags/{tag}'],check=False)
        if response.returncode:
            command(['gh','release','create',tag,'--repo',repo,'--target','main','--title',f'Original image assets {tag[-1]}',
                     '--notes','Original images published with permission by the gallery publisher. Public access does not grant visitors redistribution rights.','--latest=false'])
            release=gh_json('api',f'repos/{repo}/releases/tags/{tag}')
        else:release=json.loads(response.stdout)
        remote=gh_json('api','--paginate','--slurp',f"repos/{repo}/releases/{release['id']}/assets?per_page=100")
        uploaded={a['name']:a for page in remote for a in page}
        pending=[]
        for asset in assets:
            path=Path(asset['path']);old=uploaded.get(path.name)
            digest='sha256:'+asset['sha256']
            if old and old['size']==asset['size'] and old.get('state')=='uploaded' and (not old.get('digest') or old['digest']==digest):
                continue
            if not path.is_file() or file_hash(path)!=asset['sha256']:
                raise ValueError(f'原图校验失败，请运行 verify.py：{path.name}')
            pending.append(str(path))
        print(f'{tag} 已有 {len(assets)-len(pending)}，待上传 {len(pending)}',flush=True)
        # One CLI call per batch avoids one release lookup for every image.
        for offset in range(0,len(pending),20):
            batch=pending[offset:offset+20]
            for attempt in range(4):
                result=command(['gh','release','upload',tag,*batch,'--repo',repo,'--clobber'],check=False)
                if not result.returncode:break
                if attempt==3:raise RuntimeError(result.stderr)
                time.sleep(2**(attempt+1))
            print(f'{tag} 本次上传 {min(offset+20,len(pending))}/{len(pending)}',flush=True)


def directory_push(repo, directory, account, branch, message):
    command(['git','init','-b',branch],directory)
    command(['git','config','user.name',account['login']],directory)
    command(['git','config','user.email',f"{account['id']}+{account['login']}@users.noreply.github.com"],directory)
    command(['git','remote','add','origin',f'https://github.com/{repo}.git'],directory)
    exists=command(['git','ls-remote','--exit-code','--heads','origin',branch],directory,check=False)
    if exists.returncode==0:
        command(['git','fetch','--depth=1','origin',branch],directory)
        command(['git','reset','--mixed','FETCH_HEAD'],directory)
    elif exists.returncode!=2:raise RuntimeError(exists.stderr)
    command(['git','add','--all'],directory)
    dirty=command(['git','diff','--cached','--quiet'],directory,check=False)
    if dirty.returncode==1:command(['git','commit','-m',message],directory)
    elif dirty.returncode!=0:raise RuntimeError(dirty.stderr)
    command(['git','push','origin','HEAD:'+branch],directory)
    return command(['git','rev-parse','HEAD'],directory).stdout.strip()


def archive_push(repo,originals,directory,account):
    selected=[a for a in originals if a.get('storage')=='git']
    if not selected:return
    directory.mkdir(parents=True,exist_ok=True)
    for index,asset in enumerate(selected,1):
        source=Path(asset['path'])
        if not source.is_file() or file_hash(source)!=asset['sha256']:
            raise ValueError('原图校验失败：'+source.name)
        target=(directory/asset['relative']).resolve()
        if not target.is_relative_to(directory.resolve()/'images'):
            raise ValueError('无效资源路径')
        target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)
        if index%100==0:print(f'资源分支准备 {index}/{len(selected)}',flush=True)
    print(f'推送 {len(selected)} 张原图到 original-images 分支…',flush=True)
    directory_push(repo,directory,account,'original-images','Publish original image archive')


def pages_push(repo, directory, account):
    expected_commit=directory_push(repo,directory,account,'gh-pages','Update public static gallery')
    current=command(['gh','api',f'repos/{repo}/pages'],check=False)
    if current.returncode==0:
        page=json.loads(current.stdout)
        if page.get('source',{}).get('branch')!='gh-pages' or page.get('build_type')=='workflow':
            raise ValueError('目标仓库已有不同 Pages 配置，未覆盖；请在 Settings → Pages 选择 gh-pages 分支 / 根目录')
    else:
        command(['gh','api',f'repos/{repo}/pages','--method','POST','-f','build_type=legacy',
                 '-f','source[branch]=gh-pages','-f','source[path]=/'])
    page=gh_json('api',f'repos/{repo}/pages')
    print('仓库：https://github.com/'+repo,flush=True)
    print('Pages 地址（待构建完成）：'+page['html_url'],flush=True)
    print('部署状态：https://github.com/'+repo+'/actions',flush=True)
    # A URL from Pages settings is not proof of a successful build.
    for _ in range(30):
        latest=command(['gh','api',f'repos/{repo}/pages/builds/latest'],check=False)
        if latest.returncode==0:
            status=json.loads(latest.stdout)
            if status.get('commit')!=expected_commit:
                time.sleep(5);continue
            if status.get('status')=='built':
                print('Pages 构建已完成：'+page['html_url'],flush=True);return
            if status.get('status')=='errored':raise RuntimeError('Pages 构建失败：'+str(status.get('error')))
        time.sleep(5)
    print('Pages 仍在构建，请稍后在仓库 Actions 中确认；未报告为已部署成功。',flush=True)


def publish(args):
    if not args.authorized_images:raise ValueError('公开图片前请添加 --authorized-images，表示你已取得这些图片的公开发布授权')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',args.repo):raise ValueError('--repo 格式应为 owner/repository')
    for binary in ('git','gh'):
        if not shutil.which(binary):raise ValueError(f'请先安装 {binary}')
    if command(['gh','auth','status'],check=False).returncode:
        raise ValueError('请先执行 gh auth login --hostname github.com --git-protocol https --web 完成登录，然后重试')
    account=gh_json('api','user')
    if args.repo.split('/')[0].lower()!=account['login'].lower():raise ValueError('此发布器仅向当前登录者自己的仓库发布')
    command(['gh','auth','setup-git'])
    with tempfile.TemporaryDirectory(prefix='reference-gallery-publish-') as temporary:
        directory=Path(temporary)/'site'
        with crawl_lock(args.data):
            manifest_path=build(args.data,directory,args.repo,args.analytics_url,args.archive_from)
            manifest=json.loads(manifest_path.read_text(encoding='utf-8'))
        print('上传源代码…',flush=True)
        source_push(args.repo,account)
        print('上传原图；可中断，重新执行将跳过已完成文件…',flush=True)
        originals_upload(args.repo,manifest['originals'])
        archive_push(args.repo,manifest['originals'],Path(temporary)/'original-images',account)
        print('发布静态网页与预览图…',flush=True)
        pages_push(args.repo,directory,account)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo',required=True)
    parser.add_argument('--data',type=Path,default=DEFAULT_DATA)
    parser.add_argument('--authorized-images',action='store_true')
    parser.add_argument('--analytics-url',default=None,help='共享统计服务的 HTTPS 基础地址')
    parser.add_argument('--archive-from',default='d',choices=['none',*'0123456789abcdef'])
    try:publish(parser.parse_args())
    except (Exception,KeyboardInterrupt) as exc:
        print('\n发布未完成：'+(str(exc) or '用户中断；重新执行可续传'),file=sys.stderr)
        raise SystemExit(1)
