import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('init')
  async init(@Query('template_id') templateId?: string) {
    return this.appService.getFilters(templateId || 'icons_hpov');
  }

  @Post('search')
  async search(@Body() body: { 
    template_id: string; 
    project_name: string; 
    filters?: Record<string, any>; 
    size?: number; 
    search_after?: string[] 
  }) {
    const { template_id, project_name, filters = {}, size = 20, search_after } = body;
    return this.appService.search(template_id, project_name, filters, size, search_after);
  }

  @Post('setup')
  async setup(@Body() body: { template_id: string; project_name: string }) {
    return this.appService.setupIndexAndSample(body.template_id, body.project_name);
  }

  @Post('seed')
  async seed(@Body() body: { template_id: string; project_name: string; count?: number }) {
    return this.appService.seedData(body.template_id, body.project_name, body.count || 50);
  }
}
