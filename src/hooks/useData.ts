import { FilterConjunction, FilterOperator } from '@lark-base-open/js-sdk'
import type { FieldType, FilterInfoCondition, IGridView } from '@lark-base-open/js-sdk'
import { generateString } from 'random-ease'
import { useInfo } from '@/hooks/useInfo'
import type Layout from '@/components/layout.vue'
import type { FieldMaps, LogRowData } from '@/types'
import { fieldMaps } from '@/utils/field'
import { AsyncPool } from '@/utils/asyncpool'
import { EventBucket } from '@/utils'
import type { Progress } from '@/hooks/useProgress'
import { tKey } from '@/keys'

function getFieldMapValue(
  fieldId: null | string | undefined,
  map: FieldMaps | undefined,
  key: keyof FieldMaps,
) {
  return map && fieldId ? map[key][fieldId] || null : null
}

export const eventBucket = new EventBucket()

const fieldMap = ref<FieldMaps>({
  IdToName: {},
  IdToType: {},
  NameToId: {},
})
const offCalls = new EventBucket()
const table = shallowRef<ITable | null>(null)

const view = shallowRef<IView | null>(null)

const fieldMetaList = shallowRef<IFieldMeta[]>([])
const tableMetaList = shallowRef<ITableMeta[]>([])
const viewMetaList = shallowRef<IViewMeta[]>([])
const hooks: Record<string, (...args: any[]) => void | Promise<void>> = {}

export function useData() {
  const { app } = useInfo()
  const { t } = useI18n()
  const message = useMessage()
  provide(tKey, t)
  const layout = ref<InstanceType<typeof Layout> | null>(null)
  const _setTable = async (tableId: string | null) => {
    if (tableId) {
      layout.value?.getTablePermission(tableId)
      table.value = await bitable.base.getTableById(tableId)
      offCalls.clear()
      offCalls.add(
        table.value.onFieldAdd(getView),
        table.value.onFieldDelete(getView),
        table.value.onFieldModify(getView),
      )
      await getView()
    }
  }
  const _setView = async (viewId: string | null) => {
    if (viewId && table.value) {
      view.value = await table.value.getViewById(viewId)
      await getField()
    }
  }
  const tableId = computed<string | null>({
    get() { return table.value?.id ?? null },
    set(tableId: string | null) {
      _setTable(tableId)
    },
  })
  const viewId = computed({
    get() { return view.value?.id ?? null },
    set(viewId: string | null) {
      _setView(viewId)
    },
  })

  function createHooks<T extends (...args: any[]) => any = () => void | Promise<void>>(
    hookName: string,
  ) {
    return (fn: T) => {
      hooks[hookName] = fn
    }
  }

  async function callHook(hookName: string, ...args: any[]) {
    if (hookName in hooks)
      await hooks[hookName](...args)
  }
  function errorHandle(msg: string, error: Error): void {
    const errorMessage = error?.message || 'Unknown error occurred'
    message.error(`${msg}: ${errorMessage}`, {
      closable: true,
      duration: 0,
    })
    console.log(`${app.value.title}${msg}:`, error)
  }
  async function handleAsyncError(msg: string, func: () => Promise<any>) {
    try {
      await func()
    }
    catch (error: any) {
      errorHandle(msg, error)
    }
  }

  const onBeforeGetTable = createHooks('beforeGetTable')
  const onGetTable = createHooks('getTable')
  const onBeforeGetView = createHooks('beforeGetView')
  const onGetView = createHooks('getView')
  const onBeforeGetField = createHooks('beforeGetField')
  const onGetField = createHooks('getField')
  const onFieldTraverse = createHooks<(item: IFieldMeta) => void | Promise<void>>('fieldTraverse')

  function filterFields(
    filterTypeOrAction?: FieldType | FieldType[] | any,
    actionTypeMap?: Record<number, any[]>,
  ) {
    if (filterTypeOrAction === undefined)
      return fieldMetaList.value

    if (actionTypeMap) {
      return fieldMetaList.value?.filter((item: IFieldMeta) => {
        const actions = actionTypeMap[item.type]
        return actions ? actions.includes(filterTypeOrAction) : false
      })
    }
    const filterTypes = Array.isArray(filterTypeOrAction)
      ? filterTypeOrAction
      : [filterTypeOrAction]
    return fieldMetaList.value?.filter((item: IFieldMeta) =>
      filterTypes.includes(item.type),
    )
  }

  function getTable() {
    return handleAsyncError('Failed to get table data', async () => {
      layout.value?.update(true, t('Update Table data'))
      await callHook('beforeGetTable')
      const [
        _tableMetaList,
        selection,
      ] = await Promise.all([
        bitable.base.getTableMetaList(),
        bitable.base.getSelection(),
      ])
      tableMetaList.value = _tableMetaList
      await _setTable(selection.tableId)
      await callHook('getTable')
    })
  }

  function getView() {
    return handleAsyncError('get View Failed', async () => {
      layout.value?.update(true, t('Update view data'))
      await callHook('beforeGetView')
      if (!tableId.value || !table.value)
        throw new Error('table is empty')
      const views = await table.value.getViewMetaList()
      viewMetaList.value = views.filter((item: IViewMeta) => item.type === base.ViewType.Grid)
      if (viewMetaList.value.length > 0)
        await _setView(viewMetaList.value[0].id)
      await callHook('getView')
    })
  }

  function getField() {
    return handleAsyncError('get Field Failed', async () => {
      layout.value?.update(true, t('Update field data'))
      await callHook('beforeGetField')
      if (!table.value || !view.value)
        throw new Error('table or view is empty')
      fieldMetaList.value = await view.value.getFieldMetaList()
      fieldMap.value = fieldMaps(fieldMetaList.value)
      await callHook('getField')
      await Promise.all(fieldMetaList.value.map((item: IFieldMeta) => callHook('fieldTraverse', item)))
      layout.value?.update(false)
    })
  }

  async function getRecords(
    f: (val: { pr: Progress, records: IGetRecordsByPageResponse }) => Promise<any>,
    all = false,
    pageSize = 200,
  ): Promise<void> {
    if (!layout.value)
      throw new Error('layout not loaded')
    if (!table.value)
      throw new Error('table not loaded')
    layout.value.init()
    layout.value.update(true, t('Step 1 - Getting Table'))
    layout.value.update(true, t('Step 2 - Getting Records'))
    const pr = layout.value.spin(t('Record'), 0)
    if (all) {
      let size = 0;
      const recordsData: IGetRecordsByPageResponse = {
        hasMore: true,
        records: [],
        total: 0,
        pageToken: undefined,
      }
      while (recordsData.hasMore) {
       const { total, hasMore, pageToken, records } = await table.value.getRecordsByPage({
          pageSize,
          pageToken: recordsData.pageToken,
        });
        recordsData.hasMore = hasMore;
        recordsData.pageToken = pageToken;
        recordsData.records.push(...records)
        size = total;
      }
      pr.addTotal(size)
      await f({ pr, records: recordsData })
    }
    else {
      let vid = viewId.value
      if (!vid) {
        const selection = await bitable.base.getSelection()
        if (selection.viewId && selection.tableId === tableId.value) {
          vid = selection.viewId
        }
        else {
          const views = (await table.value.getViewMetaList())
            .filter((item: IViewMeta) => item.type === ViewType.Grid)
          vid = views[0].id
        }
      }
      const recordIdList = await bitable.ui.selectRecordIdList(tableId.value!, vid)
      pr.addTotal(recordIdList.length)
      for (const recordId of recordIdList) {
        const record = await table.value!.getRecordById(recordId)
        await f({
          pr,
          records: {
            hasMore: false,
            records: [{ fields: record.fields, recordId }],
            total: 0,
          },
        })
      }
    }
  }

  async function getRecordss({
    all = false,
    func = null as null | ((val: IRecord) => Promise<IRecord | null | undefined>),
    limit = 1000,
    pageSize = 5000,
    update = false,
    updateFunc = (value: IRecord[]) => {
      return table.value?.setRecords(value)
    },
    updateSize = 2500,
  }) {
    try {
      if (!func)
        throw new Error('getRecords need func')
      if (!layout.value)
        throw new Error('layout not loaded')
      if (!table.value)
        throw new Error('table not loaded')
      layout.value.init()
      layout.value.update(true, t('Step 1 - Getting Table'))
      layout.value.update(true, t('Step 2 - Getting Records'))
      const pr = layout.value.spin(t('Record'), 0)
      const fn: typeof func = async (val: IRecord) => {
        try {
          return await func(val)
        }
        finally {
          pr.add()
        }
      }
      const pool = new AsyncPool<typeof func>(fn, limit)
      if (update)
        pool.resultHooks(updateFunc, updateSize)

      if (!all) {
        let vid = viewId.value
        if (!vid) {
          const selection = await bitable.base.getSelection()
          if (selection.viewId && selection.tableId === tableId.value) {
            vid = selection.viewId
          }
          else {
            const views = (await table.value.getViewMetaList())
              .filter((item: IViewMeta) => item.type === ViewType.Grid)
            vid = views[0].id
          }
        }
        const recordIdList = await bitable.ui.selectRecordIdList(tableId.value!, vid)
        pr.addTotal(recordIdList.length)
        for (const item of recordIdList) {
          const record = await table.value.getRecordById(item)
          pool.run({ fields: record.fields, recordId: item })
        }
      }
      else {
        let recordsData: IGetRecordsByPageResponse = {
          hasMore: true,
          records: [],
          total: 0,
          pageToken: undefined,
        }
        let size = 0;
        while (recordsData.hasMore) {
          const { total, records, hasMore, pageToken } = await table.value.getRecordsByPage({
            pageSize,
            pageToken: recordsData.pageToken,
          })
          recordsData.hasMore = hasMore;
          recordsData.pageToken = pageToken;
          size = total;
          recordsData.records = records;
        }
        pr.addTotal(size)
        for (const item of recordsData.records){
          pool.run(item)
        }
      }
      await pool.all()
    }
    catch (err) {
      if (err instanceof Error)
        errorHandle('getRecords', err)
      else
        errorHandle('getRecords', new Error(JSON.stringify(err)))
    }
    finally {
      layout.value?.finish()
    }
  }

  const fieldId = (fieldId: null | string | undefined) => getFieldMapValue(fieldId, fieldMap.value, 'NameToId')
  const fieldName = (fieldId: null | string | undefined) => getFieldMapValue(fieldId, fieldMap.value, 'IdToName')
  const fieldType = (fieldId: null | string | undefined) => getFieldMapValue(fieldId, fieldMap.value, 'IdToType')

  const createView = async (data: LogRowData[]) => {
    if (!table.value || data.length === 0)
      return
    const filter = data.map((item) => {
      if (!item.value)
        return null
      return {
        fieldId: item.fieldId,
        fieldType: fieldType(item.fieldId),
        operator: FilterOperator.Is,
        value: item.value,
      }
    }).filter(item => item !== null) as FilterInfoCondition[]
    if (filter.length === 0)
      return
    const viewId = (await table.value.addView({
      name: `logs_${generateString(8)}`,
      type: ViewType.Grid,
    })).viewId
    try {
      const view = await table.value.getViewById(viewId) as IGridView
      if (!await view.addFilterCondition(filter))
        throw new Error('Failed to add filter condition')
      bitable.ui.switchToView(tableId.value!, viewId)
      await view.setFilterConjunction(FilterConjunction.Or)
      view.applySetting()
    }
    catch (e) {
      message.error(t('Failed to add filter condition'))
      await table.value.deleteView(viewId)
    }
  }

  onMounted(() => {
    layout.value?.upCreateView(createView)
    eventBucket.add(bitable.base.onTableAdd(() => {
      void getTable()
    }))
    eventBucket.add(bitable.base.onTableDelete(() => {
      void getTable()
    }))
  })
  onBeforeUnmount(() => {
    eventBucket.clear()
    offCalls.clear()
  })
  return {
    errorHandle,
    fieldId,
    fieldMap,
    fieldMetaList,
    fieldName,
    fieldType,
    filterFields,
    getField,
    getRecords,
    getRecordss,
    getTable,
    getView,
    layout,
    message,
    onBeforeGetField,
    onBeforeGetTable,
    onBeforeGetView,
    onFieldTraverse,
    onGetField,
    onGetTable,
    onGetView,
    t,
    table,
    tableId,
    tableMetaList,
    view,
    viewId,
    viewMetaList,
  }
}
