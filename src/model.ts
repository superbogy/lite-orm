import Debug from 'debug';
import { Builder } from './builder';
import { Dict, FindOpts, InsertOpts, ModelOpts } from './interface';
import { isEmpty, pick, has } from 'ramda';
import { Database, ISqlite } from 'sqlite';
import { TimestampSchema, ColumnSchema } from './schema';

const debug = Debug('lite-orm:model');
export class Model {
  private _db: Database;
  public _table: string;
  private _pk: string[];
  readonly _options: any;
  private _attributes: Dict;
  [key: string]: any;
  constructor(options?: ModelOpts) {
    this._attributes = {};
    this._pk = [];
    this._options = options || {};
    this.initialize();
  }

  get schema() {
    return Reflect.getMetadata('model:schema', this);
  }

  get indices() {
    return Reflect.getMetadata('model:indices', this);
  }

  get options() {
    return this._options;
  }

  get table(): string {
    return this._table;
  }

  get db() {
    return this._db;
  }

  initialize(): Model {
    const schema = this.schema;
    this._pk = Object.entries(schema)
      .filter((item) => {
        const v = item[1] as ColumnSchema;
        return !!v.pk;
      })
      .map((item) => {
        const [k] = item;
        return k;
      });
    if (this.options?.timestamp) {
      Reflect.defineMetadata(
        'model:schema',
        { ...schema, ...TimestampSchema },
        this,
      );
    }
    if (this.options?.db) {
      this._db = this.options.db;
    }
    return this;
  }

  async connect() {
    if (typeof this.db === 'function') {
      this._db = await Promise.resolve((this.db as Function)());
    } else if (this.db instanceof Promise) {
      this._db = await Promise.resolve(this.db);
    }
    return this.db;
  }

  getColumn(field: string): ColumnSchema | undefined {
    return this.schema[field];
  }

  encode<T>(filed: string, value: any): T {
    if (value === undefined) {
      return this.schema[filed]?.default;
    }
    const column = this.getColumn(filed);
    if (column?.encode) {
      return column.encode(value);
    }
    return value;
  }

  decode<T>(filed: string, value: any): T {
    if (value === undefined) {
      return value;
    }
    const column = this.getColumn(filed);
    if (column?.decode) {
      return column.decode(value);
    }
    return value;
  }

  getAttrs(): Dict {
    const schema = this.schema;
    const data: Record<string, any> = {};
    Object.keys(schema).forEach((k: string) => {
      if (has(k, this)) {
        data[k] = this[k];
      }
    });
    return { ...this._attributes, ...data };
  }

  getAttr(name: string): any {
    const data = this.getAttrs();
    return this.decode(name, data[name]);
  }

  setAttr(name: string, value: any): void {
    const schema = this.schema;
    if (name in schema) {
      this[name] = value;
      this._attributes[name] = value;
    }
  }

  purify(data: Dict): Dict {
    return Object.entries(data).reduce((acc: Dict, [key, val]) => {
      return { ...acc, [key]: this.encode(key, val) };
    }, {});
  }

  toRowData(props: Dict) {
    const schema = this.schema;
    return Object.entries(props).reduce((acc, cur) => {
      const [k, v]: [string, any] = cur;
      const col: ColumnSchema = schema[k];
      if (col && k in props) {
        acc[col.name || k] = v;
      } else {
        acc[k] = v;
      }

      return acc;
    }, {} as Record<string, any>);
  }

  toProps(row: Dict) {
    const fieldPairs = Object.entries(this.schema);
    return Object.entries(row).reduce((acc, cur) => {
      const [k, v]: [string, any] = cur;
      const item = fieldPairs.find(([key, col]: [string, any]) => {
        return col.name === k || key === k;
      });
      if (item) {
        acc[item[0]] = v;
      } else {
        acc[k] = v;
      }

      return acc;
    }, {} as Record<string, any>);
  }

  clone(): Model {
    return new (this.constructor as new () => this)();
  }

  instance(row: Dict): Model {
    const instance = this.clone();
    const data = this.toProps(row);
    for (const key in data) {
      const column = this.schema[key];
      const val = column?.decode ? column.decode(data[key]) : data[key];
      instance.setAttr(key, val);
    }

    return instance;
  }

  toObject(): Dict {
    return this.getAttrs();
  }

  toJSON(): Dict {
    return this.toObject();
  }

  async exec(sql: string): Promise<void> {
    await this.connect();
    return this.db?.exec(sql);
  }

  async call(
    method: string,
    sql: string,
    params: Record<string, any>,
  ): Promise<any> {
    await this.connect();
    if (this.options?.debug) {
      debug('[sql]: %s, [params]: %j', sql, params);
    }
    const stmt: any = await this.db.prepare(sql);
    return stmt[method](params);
  }

  async insert(payload: Dict, options?: InsertOpts): Promise<Model | number> {
    const builder = new Builder({});
    const data = this.toRowData(this.purify({ ...payload }));
    const defaultData = this.toRowData(this.defaultData());
    const { sql, params } = builder
      .table(this.table)
      .insert({ ...defaultData, ...data });
    const res = await this.call('run', sql, params);
    const { lastID } = res;
    if (this.options?.onInsert) {
      await Promise.resolve(this.options.onInsert);
    }
    if (options?.lastId) {
      return lastID;
    }
    return (await this.findById(lastID)) as Model;
  }

  async create(data: Dict, options?: InsertOpts): Promise<Model | number> {
    return this.insert(data, options);
  }

  async update(where: Dict, payload: Dict): Promise<ISqlite.RunResult> {
    const builder = new Builder({});
    const data = this.purify(payload);
    console.log('data', data);
    const witTimestamp = this.attachTimestamp(data);
    console.log(witTimestamp);
    const row = this.toRowData(witTimestamp);
    console.log('123123', row, where);
    const { sql, params } = builder
      .table(this.table)
      .where(where)
      .update({ ...row });
    console.log(sql, params);
    const res = await this.call('run', sql, params);
    await this.onChange(row);
    return res;
  }

  updateAttributes(payload: Dict): Promise<Model> {
    if (!this._pk) {
      throw new Error('updateAttributes must be called on instance');
    }
    const current = this._attributes;
    Object.entries(payload).map((item) => {
      const [key, value] = item;
      if (has(key, current)) {
        this[key] = value;
      }
    });

    return this.save();
  }

  async upsert(data: Dict): Promise<Model> {
    if (data.id) {
      const record = await this.findById(data.id);
      if (record) {
        return record.updateAttributes(data);
      }
    }

    return (await this.insert(data)) as Model;
  }

  async find(where: Dict = {}, options: FindOpts = {}): Promise<Model[]> {
    const { limit, offset, order, fields, group } = options;
    const builder = new Builder({});
    const { sql, params } = builder
      .table(this.table)
      .where(this.toRowData(where))
      .fields(fields)
      .order(order)
      .group(group)
      .limit(limit)
      .offset(offset)
      .select();
    const res = await this.call('all', sql, params);
    if (options.rows) {
      return res.map((row: Dict) => this.toProps(row));
    }
    return res.map((item: Dict) => {
      return this.instance(item);
    });
  }

  async count(where: Dict): Promise<number> {
    const res = (await this.findOne(where, {
      fields: ['count(*) as count'],
      rows: true,
    })) as Model;
    return Number(res.count);
  }

  async findOne(where: Dict, options: FindOpts = {}): Promise<Model | null> {
    const res = await this.find(where, { ...options, limit: 1 });
    if (res.length) {
      return res[0];
    }
    return null;
  }

  findAll(options?: FindOpts): Promise<Model[]> {
    return this.find({}, options);
  }

  findById(id: number | string, options?: FindOpts): Promise<Model | null> {
    return this.findOne({ id }, options);
  }

  findByIds(ids: number[], options?: FindOpts): Promise<Model[]> {
    return this.find({ id: { $in: ids } }, options);
  }

  defaultData(): Dict {
    const payload: Dict = {};
    Object.entries(this.schema).map(([k, col]: [string, any]) => {
      const def = col.default;
      if (typeof def === 'undefined') {
        return;
      }
      payload[k] = typeof def === 'function' ? def() : def;
    });
    return payload;
  }

  async onChange(changed: Dict): Promise<void> {
    for (const k in changed) {
      const col: ColumnSchema = this.schema[k];
      if (!col) {
        continue;
      }
      if (!col.onChange) {
        continue;
      }
      await Promise.resolve(col.onChange.call(this, changed[k]));
    }
  }

  getChange() {
    const res = Object.entries(this._attributes).reduce(
      (acc: Dict, cur: any[]) => {
        const [k, v] = cur;
        if (this[k] !== v) {
          acc[k] = this[k];
        }
        return acc;
      },
      {},
    );
    if (this.options?.timestamp && Object.keys(res).length) {
      return this.attachTimestamp(res);
    }
    return res;
  }

  attachTimestamp(data: Dict) {
    if (!this.options?.timestamp) {
      return data;
    }
    return { ...data, updatedAt: new Date().toISOString() };
  }

  async save(): Promise<Model> {
    const pk = pick(this._pk, this.getAttrs());
    if (!this._pk || isEmpty(pk)) {
      throw new Error('save must be called on instance');
    }
    const changed = this.getChange();
    if (!Object.keys(changed).length) {
      return this;
    }
    console.log(this._pk, changed);
    await this.update(pk, changed);
    return (await this.findOne(pk)) as Model;
  }

  async remove(): Promise<ISqlite.RunResult> {
    const pk = pick(this._pk, this._attributes);
    if (!this._pk || isEmpty(pk)) {
      throw new Error('save must be called on instance');
    }

    const res = await this.delete(pk);
    if (this.options?.onRemove) {
      await Promise.resolve(this.options.onRemove);
    }
    return res;
  }

  async deleteById(id: number): Promise<boolean> {
    const record = this.findById(id);
    if (!record) {
      return false;
    }
    const builder = new Builder({});
    const { sql, params } = builder.table(this.table).where({ id }).delete();
    await this.call('run', sql, params);
    return true;
  }

  async delete(where: Dict): Promise<ISqlite.RunResult> {
    const builder = new Builder({});
    const { sql, params } = builder.table(this.table).where(where).delete();
    return await this.call('run', sql, params);
  }
}
