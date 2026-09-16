const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// 连接配置从环境变量读取（见 .env.example；本地运行前设置 PG_PASSWORD 等）
const DB_NAME = process.env.PG_DB || 'weibo_experiment';
const CONFIG = {
  host: process.env.PG_HOST || 'localhost',
  port: Number(process.env.PG_PORT || 5432),
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || '',
};

async function run() {
  // 1. 连接到默认 postgres 库，创建 weibo_experiment 数据库
  const adminClient = new Client({ ...CONFIG, database: 'postgres' });
  await adminClient.connect();
  console.log('已连接到 PostgreSQL (postgres 库)');

  const checkRes = await adminClient.query(
    `SELECT 1 FROM pg_database WHERE datname = $1`, [DB_NAME]
  );
  if (checkRes.rows.length === 0) {
    await adminClient.query(`CREATE DATABASE ${DB_NAME}`);
    console.log(`数据库 "${DB_NAME}" 创建成功`);
  } else {
    console.log(`数据库 "${DB_NAME}" 已存在`);
  }
  await adminClient.end();

  // 2. 连接到 weibo_experiment 库，执行建表SQL
  const client = new Client({ ...CONFIG, database: DB_NAME });
  await client.connect();
  console.log(`已连接到 "${DB_NAME}"`);

  const schemaPath = path.join(__dirname, '..', 'database', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  try {
    // pg 库的 query() 支持多语句
    await client.query(sql);
    console.log('所有SQL语句执行成功!');
  } catch (err) {
    console.error('执行失败:', err.message);
    // 尝试逐条执行以定位问题
    console.log('\n尝试逐语句诊断...');
    const cleanSql = sql.replace(/--.*$/gm, ''); // 去掉注释
    const statements = cleanSql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      try {
        await client.query(stmt + ';');
        console.log(`  [OK] 语句${i + 1}: ${stmt.substring(0, 70).replace(/\n/g, ' ')}...`);
      } catch (e) {
        // 表已存在 / 索引已存在 / 重复执行 都不是致命错误
        if (e.message.includes('already exists') || e.code === '42P07' ||
            e.message.includes('duplicate key') || e.code === '23505') {
          console.log(`  [SKIP] 语句${i + 1}: 已存在，跳过`);
        } else {
          console.error(`  [FAIL] 语句${i + 1}: ${e.message}`);
          console.error(`         SQL: ${stmt.substring(0, 100)}`);
        }
      }
    }
  }

  // 3. 验证表是否创建成功
  const { rows } = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);
  console.log(`\n当前数据库表 (${rows.length} 张):`);
  rows.forEach(r => console.log(`  - ${r.table_name}`));

  // 4. 验证模板数据
  const { rows: templates } = await client.query('SELECT * FROM comment_templates');
  console.log(`\n评论模板 (${templates.length} 条):`);
  templates.forEach(t => console.log(`  - [${t.post_group}] ${t.content}`));

  await client.end();
  console.log('\n建表完成!');
}

run().catch((err) => {
  console.error('执行失败:', err.message);
  process.exit(1);
});
