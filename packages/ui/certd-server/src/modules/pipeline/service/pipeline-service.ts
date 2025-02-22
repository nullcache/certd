import { Config, Inject, Provide, Scope, ScopeEnum, sleep } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { In, Repository } from 'typeorm';
import { BaseService } from '../../../basic/base-service.js';
import { PipelineEntity } from '../entity/pipeline.js';
import { PipelineDetail } from '../entity/vo/pipeline-detail.js';
import { Executor, Pipeline, ResultType, RunHistory } from '@certd/pipeline';
import { AccessService } from './access-service.js';
import { DbStorage } from './db-storage.js';
import { StorageService } from './storage-service.js';
import { Cron } from '../../plugin/cron/cron.js';
import { HistoryService } from './history-service.js';
import { HistoryEntity } from '../entity/history.js';
import { HistoryLogEntity } from '../entity/history-log.js';
import { HistoryLogService } from './history-log-service.js';
import { logger } from '../../../utils/logger.js';
import { EmailService } from '../../basic/service/email-service.js';

const runningTasks: Map<string | number, Executor> = new Map();

/**
 * 证书申请
 */
@Provide()
@Scope(ScopeEnum.Singleton)
export class PipelineService extends BaseService<PipelineEntity> {
  @InjectEntityModel(PipelineEntity)
  repository: Repository<PipelineEntity>;
  @Inject()
  emailService: EmailService;
  @Inject()
  accessService: AccessService;
  @Inject()
  storageService: StorageService;
  @Inject()
  historyService: HistoryService;
  @Inject()
  historyLogService: HistoryLogService;

  @Inject()
  cron: Cron;

  @Config('certd')
  private certdConfig: any;

  getRepository() {
    return this.repository;
  }

  async update(entity) {
    await super.update(entity);
  }

  public async registerTriggerById(pipelineId) {
    if (pipelineId == null) {
      return;
    }
    const info = await this.info(pipelineId);
    if (info && !info.disabled) {
      const pipeline = JSON.parse(info.content);
      this.registerTriggers(pipeline);
    }
  }

  /**
   * 获取详情
   * @param id
   */
  async detail(id) {
    const pipeline = await this.info(id);
    return new PipelineDetail(pipeline);
  }

  async save(bean: PipelineEntity) {
    const pipeline = JSON.parse(bean.content);
    bean.title = pipeline.title;
    await this.addOrUpdate(bean);
  }

  /**
   * 应用启动后初始加载记录
   */
  async onStartup(immediateTriggerOnce: boolean) {
    logger.info('加载定时trigger开始');
    const idEntityList = await this.repository.find({
      select: {
        id: true,
      },
      where: {
        disabled: false,
      },
    });
    const ids = idEntityList.map(item => {
      return item.id;
    });

    //id 分段
    const idsSpan = [];
    let arr = [];
    for (let i = 0; i < ids.length; i++) {
      if (i % 20 === 0) {
        arr = [];
        idsSpan.push(arr);
      }
      arr.push(ids[i]);
    }

    //分段加载记录
    for (const idArr of idsSpan) {
      const list = await this.repository.findBy({
        id: In(idArr),
      });

      for (const entity of list) {
        const pipeline = JSON.parse(entity.content ?? '{}');
        try {
          await this.registerTriggers(pipeline, immediateTriggerOnce);
        } catch (e) {
          logger.error('加载定时trigger失败：', e);
        }
      }
    }
    logger.info('定时器数量：', this.cron.getListSize());
  }

  async registerTriggers(pipeline?: Pipeline, immediateTriggerOnce = false) {
    if (pipeline?.triggers == null) {
      return;
    }
    for (const trigger of pipeline.triggers) {
      this.registerCron(pipeline.id, trigger);
    }

    if (immediateTriggerOnce) {
      await this.trigger(pipeline.id);
      await sleep(1000);
    }
  }

  async trigger(id) {
    this.cron.register({
      name: `pipeline.${id}.trigger.once`,
      cron: null,
      job: async () => {
        logger.info('用户手动启动job');
        try {
          await this.run(id, null);
        } catch (e) {
          logger.error('手动job执行失败：', e);
        }
      },
    });
  }

  async delete(id: number) {
    const pipeline = await this.info(id);
    if (!pipeline) {
      return;
    }
    const pipelineObj = JSON.parse(pipeline.content);
    if (pipelineObj.triggers) {
      for (const trigger of pipelineObj.triggers) {
        this.removeCron(id, trigger);
      }
    }
    await super.delete([id]);
  }

  removeCron(pipelineId, trigger) {
    const name = this.buildCronKey(pipelineId, trigger.id);
    this.cron.remove(name);
  }

  registerCron(pipelineId, trigger) {
    let cron = trigger.props?.cron;
    if (cron == null) {
      return;
    }
    if (cron.startsWith('*')) {
      cron = '0' + cron.substring(1, cron.length);
    }
    const name = this.buildCronKey(pipelineId, trigger.id);
    this.cron.remove(name);
    this.cron.register({
      name,
      cron: cron,
      job: async () => {
        logger.info('定时任务触发：', pipelineId, trigger.id);
        try {
          await this.run(pipelineId, trigger.id);
        } catch (e) {
          logger.error('定时job执行失败：', e);
        }
      },
    });
    logger.info('当前定时器数量：', this.cron.getListSize());
  }

  async run(id: number, triggerId: string) {
    const entity: PipelineEntity = await this.info(id);
    const pipeline = JSON.parse(entity.content);

    if (!pipeline.stages || pipeline.stages.length === 0) {
      return;
    }

    const triggerType = this.getTriggerType(triggerId, pipeline);
    if (triggerType == null) {
      return;
    }

    const onChanged = async (history: RunHistory) => {
      //保存执行历史
      try {
        await this.saveHistory(history);
      } catch (e) {
        const pipelineEntity = new PipelineEntity();
        pipelineEntity.id = parseInt(history.pipeline.id);
        pipelineEntity.status = 'error';
        pipelineEntity.lastHistoryTime = history.pipeline.status.startTime;
        await this.update(pipelineEntity);
        logger.error('保存执行历史失败：', e);
        throw e;
      }
    };

    const userId = entity.userId;
    const historyId = await this.historyService.start(entity);

    const executor = new Executor({
      userId,
      pipeline,
      onChanged,
      accessService: this.accessService,
      storage: new DbStorage(userId, this.storageService),
      emailService: this.emailService,
      fileRootDir: this.certdConfig.fileRootDir,
    });
    try {
      runningTasks.set(historyId, executor);
      await executor.init();
      await executor.run(historyId, triggerType);
    } catch (e) {
      logger.error('执行失败：', e);
      // throw e;
    } finally {
      runningTasks.delete(historyId);
    }
  }

  async cancel(historyId) {
    const executor = runningTasks.get(historyId);
    if (executor) {
      await executor.cancel();
    }
    const entity = await this.historyService.info(historyId);
    if (entity == null) {
      return;
    }
    const pipeline: Pipeline = JSON.parse(entity.pipeline);
    pipeline.status.status = ResultType.canceled;
    pipeline.status.result = ResultType.canceled;
    const runtime = new RunHistory(historyId, null, pipeline);
    await this.saveHistory(runtime);
  }

  private getTriggerType(triggerId, pipeline) {
    let triggerType = 'user';
    if (triggerId != null) {
      //如果不是手动触发
      //查找trigger
      const found = this.findTrigger(pipeline, triggerId);
      if (!found) {
        //如果没有找到triggerId，说明被用户删掉了，这里再删除一次
        this.cron.remove(this.buildCronKey(pipeline.id, triggerId));
        triggerType = null;
      } else {
        logger.info('timer trigger:' + found.id, found.title, found.cron);
        triggerType = 'timer';
      }
    }
    return triggerType;
  }

  private buildCronKey(pipelineId, triggerId) {
    return `pipeline.${pipelineId}.trigger.${triggerId}`;
  }

  private findTrigger(pipeline, triggerId) {
    for (const trigger of pipeline.triggers) {
      if (trigger.id === triggerId) {
        return trigger;
      }
    }
    return;
  }

  private async saveHistory(history: RunHistory) {
    //修改pipeline状态
    const pipelineEntity = new PipelineEntity();
    pipelineEntity.id = parseInt(history.pipeline.id);
    pipelineEntity.status = history.pipeline.status.status + '';
    pipelineEntity.lastHistoryTime = history.pipeline.status.startTime;
    await this.update(pipelineEntity);

    const entity: HistoryEntity = new HistoryEntity();
    entity.id = parseInt(history.id);
    entity.userId = history.pipeline.userId;
    entity.status = pipelineEntity.status;
    entity.pipeline = JSON.stringify(history.pipeline);
    entity.pipelineId = parseInt(history.pipeline.id);
    await this.historyService.save(entity);

    const logEntity: HistoryLogEntity = new HistoryLogEntity();
    logEntity.id = entity.id;
    logEntity.userId = entity.userId;
    logEntity.pipelineId = entity.pipelineId;
    logEntity.historyId = entity.id;
    logEntity.logs = JSON.stringify(history.logs);
    await this.historyLogService.addOrUpdate(logEntity);
  }
}
